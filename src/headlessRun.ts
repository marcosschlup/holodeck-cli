import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { quoteForCmd, type ClaudeExecutable } from './claudeLauncher.js'
import type { ClaimedExecution } from './executionApi.js'

// One Headless run (HOL-131): a `claude -p` process working one claimed Task,
// with no person watching. Flags checked against Claude Code 2.1.282
// (2026-09-27 spike, recorded on HOL-131):
//
// - `--permission-mode auto --permission-prompts none` (decided with Marcos):
//   Claude Code's own classifier approves what it judges safe, and anything
//   that would still ask is denied at once instead of waiting for nobody.
//   Auto mode depends on the model: on one that doesn't support it (Haiku in
//   the spike) Claude Code silently falls back to `default`, where every edit
//   is denied. The stream's `init` message says which mode really applied, so
//   the run record can show it.
// - `-w <name>`: Claude Code's own worktree, `.claude/worktrees/<name>` on a
//   `worktree-<name>` branch, so a run never touches the owner's working copy
//   and concurrent runs never touch each other. Left behind when the process
//   ends (worktree.ts cleans it up). Only in a git repository.
// - The user's own MCP servers stay available (Marcos); Holodeck is added as
//   `holodeck-agent`, a name of its own so it can't be confused with a
//   Holodeck server the owner has configured for themselves as another
//   identity.
// - `--output-format stream-json --verbose`: one JSON message per line, the
//   final `result` carrying cost, turns and permission denials (and what
//   HOL-179 will turn into live activity).
// - `--no-session-persistence`: a run is never resumed, so nothing is saved.
// - The prompt goes through stdin, not the command line: on Windows an npm
//   install of Claude Code is a `.cmd` started through cmd.exe, which mangles
//   newlines and quotes in an argument.

export const HOLODECK_MCP_SERVER = 'holodeck-agent'

// What the run is asked to do, by why it was started. Short on purpose: the
// Agent's persona and how to use Holodeck arrive as the Holodeck MCP server's
// own instructions (headlessMcp.ts), the same text any session of this Agent
// gets.
export function buildRunPrompt(execution: ClaimedExecution): string {
  const task = `${execution.task.displayId} ("${execution.task.title}")`
  const tools = `Use the ${HOLODECK_MCP_SERVER} MCP tools to work with Holodeck as yourself.`
  const finish =
    'Work until the task is done, then record what happened with set_resolution and call finish_status_work. If you need an answer from a person before you can go on, use raise_blocked and stop: you will be started again once it is resolved. Nobody is watching this session, so anything you only write here is lost; put it in Holodeck.'
  switch (execution.trigger) {
    case 'block_resolved':
      return `A block on Holodeck task ${task}, which is assigned to you, was just resolved. ${tools} Read the task with get_task and its latest activity with get_task_activity to find the answer, then carry on with the work. ${finish}`
    case 'mention':
      return `You were mentioned in a note on Holodeck task ${task}. ${tools} Read it with list_my_mentions and get_task, and do what it asks; answer with add_interaction. If it asks you to work on the task, ${finish.charAt(0).toLowerCase()}${finish.slice(1)}`
    case 'assignment':
      return `Holodeck task ${task} was assigned to you. ${tools} Start with start_working_on_task, then read the task with get_task. ${finish}`
  }
}

export interface RunArgumentsInput {
  mcpConfigPath: string
  worktreeName?: string
  model: string | null
  effort: string | null
}

export function buildRunArguments(input: RunArgumentsInput): string[] {
  return [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'auto',
    '--permission-prompts',
    'none',
    '--no-session-persistence',
    '--mcp-config',
    input.mcpConfigPath,
    ...(input.worktreeName ? ['-w', input.worktreeName] : []),
    ...(input.model ? ['--model', input.model] : []),
    ...(input.effort ? ['--effort', input.effort] : []),
  ]
}

// What the daemon keeps from a run's stream: enough for the run record and
// the report to Holodeck, never the content of tool calls or messages.
export interface RunSummary {
  // Where the run really worked (its worktree, when there is one).
  cwd?: string
  // The permission mode Claude Code actually applied (see above).
  permissionMode?: string
  result?: {
    subtype: string
    isError: boolean
    terminalReason?: string
    costUsd?: number
    turns?: number
    permissionDenials: number
    // The final text, cut short: kept only to explain a failure.
    text?: string
  }
}

const MAX_RESULT_TEXT = 500

export function createRunSummary(): { add: (line: string) => void; summary: RunSummary } {
  const summary: RunSummary = {}
  return {
    summary,
    add(line) {
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        return
      }
      if (message.type === 'system' && message.subtype === 'init') {
        summary.cwd = typeof message.cwd === 'string' ? message.cwd : undefined
        summary.permissionMode = typeof message.permissionMode === 'string' ? message.permissionMode : undefined
      } else if (message.type === 'result') {
        summary.result = {
          subtype: String(message.subtype),
          isError: message.is_error === true,
          terminalReason: typeof message.terminal_reason === 'string' ? message.terminal_reason : undefined,
          costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : undefined,
          turns: typeof message.num_turns === 'number' ? message.num_turns : undefined,
          permissionDenials: Array.isArray(message.permission_denials) ? message.permission_denials.length : 0,
          text: typeof message.result === 'string' ? message.result.slice(0, MAX_RESULT_TEXT) : undefined,
        }
      }
    },
  }
}

export interface RunExit {
  exitCode: number | null
  // The last lines Claude Code wrote to stderr, to explain a failure.
  stderrTail: string
}

// A run succeeded when Claude Code exited cleanly AND said so in its result.
// Otherwise the reason goes to Holodeck (which blocks the Task with it), so it
// says what a person needs to know: exit code, result kind, the end of the
// output.
export function judgeRun(exit: RunExit, summary: RunSummary): { success: boolean; reason?: string } {
  const result = summary.result
  if (exit.exitCode === 0 && result && !result.isError && result.subtype === 'success') {
    return { success: true }
  }
  const parts = [
    exit.exitCode === null ? 'Claude Code was stopped' : `Claude Code exited with code ${exit.exitCode}`,
    // An API error can come back as subtype `success` with `is_error` set.
    result ? `result: ${result.isError && result.subtype === 'success' ? 'error' : result.subtype}${result.terminalReason ? ` (${result.terminalReason})` : ''}` : 'no result',
    ...(result && result.permissionDenials > 0 ? [`${result.permissionDenials} permission denial(s)`] : []),
    ...(result?.text ? [`last message: ${result.text}`] : []),
    ...(exit.stderrTail ? [`stderr: ${exit.stderrTail}`] : []),
  ]
  return { success: false, reason: parts.join('; ') }
}

const STDERR_TAIL_CHARS = 1000

export interface StartedRun {
  child: ChildProcess
  exited: Promise<RunExit>
}

// Spawns Claude Code, feeds it the prompt, and hands every stdout line to
// `onLine` (the raw stream is also written to `streamFile`).
export function startRun(input: {
  executable: ClaudeExecutable
  args: string[]
  prompt: string
  cwd: string
  env: NodeJS.ProcessEnv
  streamFile: string
  onLine: (line: string) => void
}): StartedRun {
  const { executable, args } = input
  const child = executable.needsShell
    ? spawn([executable.path, ...args].map(quoteForCmd).join(' '), { cwd: input.cwd, env: input.env, shell: true, stdio: 'pipe' })
    : spawn(executable.path, args, { cwd: input.cwd, env: input.env, stdio: 'pipe' })

  fs.mkdirSync(path.dirname(input.streamFile), { recursive: true })
  const stream = fs.createWriteStream(input.streamFile)
  let pending = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    stream.write(chunk)
    pending += chunk
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim()
      pending = pending.slice(newline + 1)
      if (line) {
        input.onLine(line)
      }
      newline = pending.indexOf('\n')
    }
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS)
  })
  child.stdin?.on('error', () => {})
  child.stdin?.end(input.prompt)

  const exited = new Promise<RunExit>((resolve) => {
    let finished = false
    // A spawn failure can fire both 'error' and 'close'.
    const finish = (exitCode: number | null) => {
      if (finished) {
        return
      }
      finished = true
      if (pending.trim()) {
        input.onLine(pending.trim())
      }
      stream.end()
      resolve({ exitCode, stderrTail: stderr.trim() })
    }
    child.once('error', (error) => {
      stderr = `${stderr}\n${error.message}`.slice(-STDERR_TAIL_CHARS)
      finish(null)
    })
    child.once('close', (code) => finish(code))
  })
  return { child, exited }
}

// Ends a run early (the server says it is no longer running, or the daemon is
// stopping). On Windows the child can be cmd.exe wrapping Claude Code, and
// killing it would leave Claude Code running, so the whole tree goes.
export function stopRun(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) {
    return
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill('SIGTERM')
  }
}
