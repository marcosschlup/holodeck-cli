import { spawn } from 'node:child_process'
import { isSea } from 'node:sea'
import { sendIpcRequest, type IpcResponse, type PersonaStatus } from './ipc.js'

// The CLI's side of the daemon (daemon.ts): starting it when needed, and the
// typed answers of each op.

export type StatusOk = Extract<IpcResponse, { op: 'status' }>

function isOk<Op extends Extract<IpcResponse, { ok: true }>['op']>(
  response: IpcResponse | null,
  op: Op,
): response is Extract<IpcResponse, { op: Op }> {
  return response !== null && response.ok && response.op === op
}

export async function daemonStatus(): Promise<StatusOk | null> {
  const response = await sendIpcRequest({ op: 'status' })
  return isOk(response, 'status') ? response : null
}

// Starts the daemon if it isn't already reachable, detached from this
// terminal. Resolves to its status once it answers, or null if it never did.
//
// It re-runs this same program with `--__daemon` (cli.ts): `process.execPath` +
// `process.argv[1]` is "this script, the way it's running now" under tsx or
// node; in a single executable (`isSea()`) the executable itself is the
// program. The extra 'ipc' stdio slot lets the child say "listening" the
// moment it is (runDaemon's `process.send('ready')`), instead of polling.
export async function ensureDaemonRunning(): Promise<StatusOk | null> {
  const existing = await daemonStatus()
  if (existing) {
    return existing
  }

  const respawnArgs = isSea() ? ['--__daemon'] : [...process.execArgv, process.argv[1] as string, '--__daemon']
  const child = spawn(process.execPath, respawnArgs, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  })

  const becameReady = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 10_000)
    child.once('message', (message: unknown) => {
      if (message === 'ready') {
        clearTimeout(timeout)
        resolve(true)
      }
    })
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve(false)
    })
  })
  // After 'exit' the IPC channel is already gone, and disconnecting again throws.
  if (child.connected) {
    child.disconnect()
  }
  child.unref()

  return becameReady ? daemonStatus() : null
}

export async function registerWithDaemon(agentId: string, name: string, cwd: string): Promise<boolean> {
  // Longer than the 2s default: it replaces a worker, which can wait for runs to end.
  return isOk(await sendIpcRequest({ op: 'register', agentId, name, cwd }, 15_000), 'register')
}

// null: the daemon isn't running.
export async function listDaemonAgents(): Promise<PersonaStatus[] | null> {
  const response = await sendIpcRequest({ op: 'list' })
  return isOk(response, 'list') ? response.personas : null
}

export async function setAgentPaused(agentId: string, paused: boolean): Promise<boolean | null> {
  const response = await sendIpcRequest({ op: paused ? 'pause' : 'unpause', agentId }, 15_000)
  if (isOk(response, 'pause') || isOk(response, 'unpause')) {
    return response.found
  }
  return null
}

// null: the daemon isn't running.
export async function forgetAgent(agentId: string): Promise<boolean | null> {
  // Runs going are ended and reported first.
  const response = await sendIpcRequest({ op: 'forget', agentId }, 30_000)
  return isOk(response, 'forget') ? response.removed : null
}

export async function shutDownDaemon(): Promise<boolean> {
  return isOk(await sendIpcRequest({ op: 'shutdown' }), 'shutdown')
}
