import fs from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { input, number, select } from '@inquirer/prompts'
import {
  ensureDaemonRunning,
  forgetAgent,
  listDaemonAgents,
  registerWithDaemon,
  setAgentPaused,
} from './daemonClient.js'
import { getAgentAccessToken, setMaxConcurrentSessions, type AgentSummary } from './holodeckApi.js'
import { isMissingFromGitIgnore } from './mcpConfig.js'
import { readRunRecords, streamFilePath, type RunRecord } from './runHistory.js'
import { loadPersonas, type PersonaRecord } from './store.js'
import { isGitRepository } from './worktree.js'

// The command-line side of Agents that work in the background (Holodeck type
// `headless`, HOL-131). Same wording rules as agentCommands.ts (HOL-135): the
// person sets up and starts an Agent; "headless", "daemon" and Claude Code
// flags only appear with --verbose.

const MAX_CONCURRENT_SESSIONS = 5

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function setUpHeadlessAgent(agent: AgentSummary, verbose: boolean): Promise<void> {
  // Proves the Agent can work this way (exists, right type) before asking anything.
  try {
    await getAgentAccessToken(agent.id, 'headless')
  } catch (error) {
    console.log(`Couldn't get ${agent.name} ready: ${errorMessage(error)}`)
    return
  }

  const cwd = resolvePath(await input({ message: `Which folder should ${agent.name} work in?`, default: process.cwd() }))
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    console.log(`${cwd} isn't a folder.`)
    return
  }

  if (await isGitRepository(cwd)) {
    const chosen = await number({
      message: `How many tasks may ${agent.name} work on at the same time? (1 to ${MAX_CONCURRENT_SESSIONS})`,
      default: agent.maxConcurrentSessions,
      min: 1,
      max: MAX_CONCURRENT_SESSIONS,
      required: true,
    })
    if (chosen !== undefined && chosen !== agent.maxConcurrentSessions) {
      try {
        await setMaxConcurrentSessions(agent.id, chosen)
      } catch (error) {
        console.log(`Couldn't save that: ${errorMessage(error)}`)
        return
      }
    }
    if (isMissingFromGitIgnore(cwd, '.claude/worktrees/')) {
      console.log(
        "Heads up: each task gets its own copy of this repository under .claude/worktrees/, which git doesn't ignore here yet. Add .claude/worktrees/ to your .gitignore.",
      )
    }
  } else {
    console.log(`This folder isn't a git repository, so ${agent.name} works on one task at a time here.`)
  }

  if (!(await ensureDaemonRunning()) || !(await registerWithDaemon(agent.id, agent.name, cwd))) {
    console.log(`Couldn't start ${agent.name} in the background. Run \`holodeck doctor\` to look for the cause.`)
    return
  }
  console.log(`${agent.name} is working in the background from ${cwd}, picking up the tasks assigned to it in Holodeck.`)
  console.log('See what it did with: holodeck logs')
  if (verbose) {
    console.log(
      '\nThe holodeck daemon claims each task from Holodeck and runs it as `claude -p` (auto permission mode, prompts denied), in its own git worktree when the folder is a repository. It keeps running after this terminal closes; `holodeck agent pause` stops it taking new work.',
    )
  }
}

// Background Agents set up on this machine, for the pickers.
export function backgroundAgents(): PersonaRecord[] {
  return loadPersonas()
}

export async function startBackgroundAgent(record: PersonaRecord): Promise<void> {
  if (!(await ensureDaemonRunning())) {
    console.log(`Couldn't start ${record.name} in the background. Run \`holodeck doctor\` to look for the cause.`)
    process.exitCode = 1
    return
  }
  const found = await setAgentPaused(record.agentId, false)
  if (!found) {
    console.log(`${record.name} isn't set up on this machine any more. Run: holodeck agent setup`)
    return
  }
  console.log(`${record.name} is working in the background from ${record.cwd}.`)
}

function describeStatus(status: string, running: number): string {
  if (status === 'paused') {
    return running > 0 ? `paused, finishing ${running} task(s)` : 'paused'
  }
  if (status === 'replaced') {
    return 'running on another machine now; start it again here to take it back'
  }
  if (running > 0) {
    return `working on ${running} task(s)`
  }
  return status === 'connected' ? 'waiting for work' : 'connecting to Holodeck'
}

export async function listBackgroundAgents(): Promise<void> {
  const records = backgroundAgents()
  if (records.length === 0) {
    return
  }
  const live = await listDaemonAgents()
  console.log('\nWorking in the background on this machine:')
  for (const record of records) {
    const status = live?.find((candidate) => candidate.agentId === record.agentId)
    const state = status ? describeStatus(status.status, status.running) : record.paused ? 'paused' : 'stopped (run: holodeck agent start)'
    console.log(`  ${record.name}  ${state}  (${record.cwd})`)
  }
}

async function pickBackgroundAgent(message: string): Promise<PersonaRecord | undefined> {
  const records = backgroundAgents()
  if (records.length === 0) {
    console.log('No Agents work in the background on this machine. Set one up with: holodeck agent setup')
    return undefined
  }
  if (records.length === 1) {
    return records[0]
  }
  return select({ message, choices: records.map((record) => ({ name: `${record.name} (${record.cwd})`, value: record })) })
}

export async function runAgentPause(): Promise<void> {
  const record = await pickBackgroundAgent('Which Agent should stop taking new tasks?')
  if (!record) {
    return
  }
  const found = await setAgentPaused(record.agentId, true)
  console.log(
    found === null
      ? `${record.name} isn't running on this machine right now.`
      : `${record.name} won't take new tasks until you run \`holodeck agent start\`. Tasks it already started finish.`,
  )
}

export async function runAgentForget(): Promise<void> {
  const record = await pickBackgroundAgent('Which Agent should stop working on this machine?')
  if (!record) {
    return
  }
  const removed = await forgetAgent(record.agentId)
  if (removed === null) {
    // The daemon isn't running: the record is only on disk.
    if (!(await ensureDaemonRunning()) || (await forgetAgent(record.agentId)) === null) {
      console.log(`Couldn't remove ${record.name}. Run \`holodeck doctor\` to look for the cause.`)
      return
    }
  }
  console.log(
    `${record.name} no longer works on this machine. Tasks already assigned to it wait in Holodeck until it is set up somewhere again.`,
  )
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function formatRun(record: RunRecord, agentId: string, verbose: boolean): string {
  const started = new Date(record.startedAt)
  const when = `${started.toLocaleDateString()} ${started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  const duration = formatDuration(Date.parse(record.endedAt) - started.getTime())
  const cost = record.costUsd === undefined ? '' : `  $${record.costUsd.toFixed(2)}`
  const lines = [`${when}  ${record.taskDisplayId}  ${record.success ? 'done' : 'failed'}  ${duration}${cost}  ${record.taskTitle}`]
  if (!record.success && record.reason) {
    lines.push(`    ${record.reason}`)
  }
  if (record.permissionMode && record.permissionMode !== 'auto') {
    lines.push(`    ran in "${record.permissionMode}" permission mode (its model may not support auto), so edits were refused`)
  }
  if (record.worktree === 'kept' && record.cwd) {
    lines.push(`    left uncommitted changes in ${record.cwd}`)
  }
  if (verbose) {
    lines.push(`    exit code ${record.exitCode ?? 'none'}, ${record.turns ?? '?'} turns, stream: ${streamFilePath(agentId, record.entryId)}`)
  }
  return lines.join('\n')
}

// `holodeck logs` (HOL-127's redesign): the runs of one background Agent,
// newest first.
export async function runLogs(options: { verbose?: boolean; limit?: number }): Promise<void> {
  const record = await pickBackgroundAgent('Whose runs?')
  if (!record) {
    return
  }
  const runs = readRunRecords(record.agentId, options.limit ?? 20)
  if (runs.length === 0) {
    console.log(`${record.name} hasn't worked on any task on this machine yet.`)
    return
  }
  console.log(runs.map((run) => formatRun(run, record.agentId, Boolean(options.verbose))).join('\n'))
}
