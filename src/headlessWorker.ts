import fs from 'node:fs'
import path from 'node:path'
import { isSea } from 'node:sea'
import type { ChildProcess } from 'node:child_process'
import { startPersonaConnection, type PersonaConnection } from './agentConnection.js'
import { resolveClaudeExecutable } from './claudeLauncher.js'
import { loadClaudeToken } from './config.js'
import {
  claimExecution,
  reportExecutionEnd,
  sendExecutionHeartbeat,
  type ClaimedExecution,
} from './executionApi.js'
import { createHeadlessActivityReporter } from './headlessActivity.js'
import { getAgentAccessToken, listMyAgents } from './holodeckApi.js'
import { createLiveActivityDelivery } from './liveActivityDelivery.js'
import {
  buildRunArguments,
  buildRunPrompt,
  createRunSummary,
  HOLODECK_MCP_SERVER,
  judgeRun,
  startRun,
  stopRun,
} from './headlessRun.js'
import { dataDir } from './paths.js'
import { appendRunRecord, streamFilePath, type RunRecord } from './runHistory.js'
import type { PersonaRecord } from './store.js'
import { cleanUpWorktree, isGitRepository, worktreeNameFor } from './worktree.js'

// One Headless Agent inside the daemon (HOL-131): holds its `/agent/events`
// connection, claims work from Holodeck's queue (HOL-129) and runs each claimed
// Task as its own `claude -p` process (headlessRun.ts).
//
// When it claims: on every (re)connect, on an `execution_queued` push, and
// whenever one of its runs ends. The queue is durable on the server, so a push
// lost while the connection was down (Railway cuts it every 15 minutes) costs
// nothing: the reconnect claims anyway. Claiming repeats until the server has
// nothing more or the Agent is at its `maxConcurrentSessions` (the server
// enforces that). A folder that isn't a git repository has no worktrees to keep
// runs apart, so there it runs one at a time whatever the limit.

// The server fails a run after 5 minutes without one (EXECUTION_LEASE_MS).
const HEARTBEAT_INTERVAL_MS = 60_000
const REPORT_ATTEMPTS = 3

interface ActiveRun {
  execution: ClaimedExecution
  child: ChildProcess
  stoppedByServer: boolean
  // Set when this machine ended the run itself (pause/forget/shutdown).
  stoppedHere?: string
}

export interface HeadlessWorker {
  status: () => string
  running: () => number
  // Stop taking new work; runs already going finish on their own.
  pause: () => Promise<void>
  // Take work again (after a pause, or after another machine took over).
  resume: () => void
  // Stop everything: runs going are ended and reported as failed with `reason`.
  shutdown: (reason: string) => Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// How Claude Code starts this same `holodeck` for the run's MCP server: the
// daemon's own executable (and script, outside a single binary), so the MCP
// server is always the same version as the daemon, PATH or not.
function selfCommand(args: string[]): { command: string; args: string[] } {
  return isSea()
    ? { command: process.execPath, args }
    : { command: process.execPath, args: [...process.execArgv, process.argv[1] as string, ...args] }
}

// No secret in it: headlessMcp.ts gets the token itself.
function writeMcpConfig(agentId: string): string {
  const file = path.join(dataDir, 'headless', agentId, 'mcp.json')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const config = { mcpServers: { [HOLODECK_MCP_SERVER]: selfCommand(['headless', 'mcp', agentId]) } }
  fs.writeFileSync(file, JSON.stringify(config, null, 2))
  return file
}

export function startHeadlessWorker(
  record: PersonaRecord,
  serverUrl: string,
  log: (message: string) => void,
): HeadlessWorker {
  const agentLog = (message: string) => log(`[${record.name}] ${message}`)
  const getToken = async () => (await getAgentAccessToken(record.agentId, 'headless')).accessToken
  const runs = new Map<string, ActiveRun>()
  const mcpConfigPath = writeMcpConfig(record.agentId)
  const gitRepository = isGitRepository(record.cwd)
  // Live activity of every run of this Agent (HOL-179), batched to Holodeck.
  const delivery = createLiveActivityDelivery({ serverUrl, getToken, log: agentLog })
  let paused = false
  let replaced = false
  let claiming = false
  let claimAgain = false

  async function canStartAnother(): Promise<boolean> {
    return !paused && !replaced && ((await gitRepository) || runs.size === 0)
  }

  async function claimLoop(): Promise<void> {
    if (claiming) {
      claimAgain = true
      return
    }
    claiming = true
    try {
      do {
        claimAgain = false
        while (await canStartAnother()) {
          const execution = await claimExecution(serverUrl, await getToken())
          if (!execution) {
            break
          }
          await launch(execution)
        }
      } while (claimAgain)
    } catch (error) {
      agentLog(`couldn't claim work: ${errorMessage(error)}`)
    } finally {
      claiming = false
    }
  }

  async function launch(execution: ClaimedExecution): Promise<void> {
    const startedAt = new Date().toISOString()
    agentLog(`starting ${execution.task.displayId} (${execution.trigger})`)
    const executable = resolveClaudeExecutable(process.platform, process.env)
    if (!executable) {
      await finish(execution, startedAt, { exitCode: null, stderrTail: '' }, createRunSummary().summary, {
        reason: "Claude Code (`claude`) isn't on the PATH of the machine running this Agent.",
      })
      return
    }
    // The Agent's model and effort as set in Holodeck now, not when it was set up.
    const agent = (await listMyAgents('headless').catch(() => [])).find((candidate) => candidate.id === record.agentId)
    const worktreeName = (await gitRepository) ? worktreeNameFor(execution) : undefined
    const claudeToken = loadClaudeToken()
    const { summary, add } = createRunSummary()
    const activity = createHeadlessActivityReporter({
      entryId: execution.id,
      task: { taskId: execution.task.id },
      holodeckToolPrefix: `mcp__${HOLODECK_MCP_SERVER}__`,
      send: delivery.enqueue,
    })
    const started = startRun({
      executable,
      args: buildRunArguments({ mcpConfigPath, worktreeName, model: agent?.model ?? null, effort: agent?.effort ?? null }),
      prompt: buildRunPrompt(execution),
      cwd: record.cwd,
      env: { ...process.env, ...(claudeToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeToken } : {}) },
      streamFile: streamFilePath(record.agentId, execution.id),
      onLine: (line) => {
        add(line)
        activity.handleLine(line)
      },
    })
    const active: ActiveRun = { execution, child: started.child, stoppedByServer: false }
    runs.set(execution.id, active)
    void started.exited.then(async (exit) => {
      runs.delete(execution.id)
      activity.finish(active.stoppedByServer || active.stoppedHere ? 'interrupted' : judgeRun(exit, summary).success ? 'success' : 'error')
      await finish(execution, startedAt, exit, summary, {
        stoppedByServer: active.stoppedByServer,
        reason: active.stoppedHere,
        worktree: worktreeName !== undefined,
      })
      void claimLoop()
    })
  }

  async function finish(
    execution: ClaimedExecution,
    startedAt: string,
    exit: { exitCode: number | null; stderrTail: string },
    summary: ReturnType<typeof createRunSummary>['summary'],
    context: { stoppedByServer?: boolean; reason?: string; worktree?: boolean },
  ): Promise<void> {
    const judged = context.reason ? { success: false, reason: context.reason } : judgeRun(exit, summary)
    let worktree: RunRecord['worktree'] = 'none'
    if (context.worktree && summary.cwd && path.resolve(summary.cwd) !== path.resolve(record.cwd)) {
      const cleanup = await cleanUpWorktree(record.cwd, summary.cwd)
      worktree = cleanup.outcome === 'failed' ? 'cleanup_failed' : cleanup.outcome
      if (cleanup.outcome === 'kept') {
        agentLog(`${execution.task.displayId} left uncommitted changes in ${cleanup.path}`)
      } else if (cleanup.outcome === 'failed') {
        agentLog(`couldn't remove the worktree ${cleanup.path}: ${cleanup.error}`)
      }
    }

    // The server already ended a run it stopped hearing from; nothing to report.
    if (!context.stoppedByServer) {
      for (let attempt = 1; attempt <= REPORT_ATTEMPTS; attempt += 1) {
        try {
          await reportExecutionEnd(serverUrl, await getToken(), execution.id, judged)
          break
        } catch (error) {
          agentLog(`couldn't report how ${execution.task.displayId} ended (attempt ${attempt}): ${errorMessage(error)}`)
          await sleep(2000 * attempt)
        }
      }
    }

    appendRunRecord(record.agentId, {
      entryId: execution.id,
      taskDisplayId: execution.task.displayId,
      taskTitle: execution.task.title,
      trigger: execution.trigger,
      startedAt,
      endedAt: new Date().toISOString(),
      exitCode: exit.exitCode,
      success: judged.success,
      reason: judged.reason,
      costUsd: summary.result?.costUsd,
      turns: summary.result?.turns,
      permissionMode: summary.permissionMode,
      permissionDenials: summary.result?.permissionDenials,
      cwd: summary.cwd,
      worktree,
      stoppedByServer: context.stoppedByServer || undefined,
    })
    agentLog(`${execution.task.displayId} ${judged.success ? 'finished' : `failed: ${judged.reason}`}`)
  }

  const heartbeat = setInterval(() => {
    for (const run of runs.values()) {
      void (async () => {
        try {
          if ((await sendExecutionHeartbeat(serverUrl, await getToken(), run.execution.id)) === 'not_running') {
            agentLog(`Holodeck no longer counts ${run.execution.task.displayId} as running; stopping it`)
            run.stoppedByServer = true
            stopRun(run.child)
          }
        } catch (error) {
          // A missed heartbeat or two is fine; the server waits five minutes.
          agentLog(`heartbeat for ${run.execution.task.displayId} failed: ${errorMessage(error)}`)
        }
      })()
    }
  }, HEARTBEAT_INTERVAL_MS)

  let connection: PersonaConnection | undefined
  function connect(): void {
    connection = startPersonaConnection({ name: record.name, token: getToken }, serverUrl, {
      log,
      tracksPresence: false,
      onConnected: () => void claimLoop(),
      onExecutionQueued: () => void claimLoop(),
      // Another machine runs this same Agent now. Reconnecting would take the
      // connection back and forth between the two forever, so this one stops
      // taking work (runs going finish) until it is started again here.
      onConnectionReplaced: () => {
        replaced = true
        agentLog('another machine is running this Agent now; this one stopped taking work')
      },
    })
  }
  connect()

  async function endRuns(reason: string): Promise<void> {
    const ending = [...runs.values()]
    for (const run of ending) {
      run.stoppedHere = reason
      stopRun(run.child)
    }
    // Wait until each is reported and recorded.
    while (runs.size > 0) {
      await sleep(200)
    }
  }

  return {
    status: () => (paused ? 'paused' : replaced ? 'replaced' : (connection?.getStatus() ?? 'connecting')),
    running: () => runs.size,
    async pause() {
      paused = true
      await connection?.stop()
    },
    resume() {
      if (!paused && !replaced) {
        return
      }
      paused = false
      replaced = false
      void connection?.stop()
      connect()
    },
    async shutdown(reason) {
      paused = true
      clearInterval(heartbeat)
      await Promise.all([connection?.stop(), endRuns(reason)])
      await delivery.stop()
    },
  }
}
