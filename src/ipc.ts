import net from 'node:net'
import path from 'node:path'
import fs from 'node:fs'
import { dataDir } from './paths.js'

// Where the daemon listens, and every CLI command connects to. Windows has
// no filesystem-path domain sockets — named pipes are addressed by name
// under \\.\pipe\ instead — so the two platforms need genuinely different
// addresses, not just different path separators. Everything else in this
// file (net.createServer/net.connect) already treats both the same way.
export function ipcAddress(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\holodeck'
  }
  return path.join(dataDir, 'daemon.sock')
}

// The daemon's own PID, written alongside the socket — not load-bearing
// for the IPC channel itself (that's the socket/pipe's job), just a cheap
// way for a human to `ps`/Task Manager the process directly if something
// ever needs that.
export function pidFilePath(): string {
  return path.join(dataDir, 'daemon.pid')
}

// Every request is one op name plus whatever payload that op needs —
// deliberately a flat, growable union rather than a generic
// {method, params} envelope, so each new op adds one variant here instead
// of a second layer of "what shape is params" to maintain.
//
// The per-Agent ops are about the Agents that work in the background on this
// machine (HOL-131, store.ts): `register` (from `holodeck agent setup`) adds
// one and puts it to work; `pause`/`unpause` stop and resume taking new work
// without forgetting it; `forget` removes it. Daemon-level lifecycle
// (`status`, `shutdown`) stays separate, so no command means two things
// depending on whether an Agent was named.
export type IpcRequest =
  | { op: 'status' }
  | { op: 'register'; agentId: string; name: string; cwd: string }
  | { op: 'pause'; agentId: string }
  | { op: 'unpause'; agentId: string }
  | { op: 'forget'; agentId: string }
  | { op: 'list' }
  | { op: 'shutdown' }

// What `list` reports for one Agent: `status` is 'paused', 'connecting',
// 'reconnecting', 'connected' or 'replaced' (another machine took the Agent
// over), `running` how many runs it has going right now.
export interface PersonaStatus {
  agentId: string
  name: string
  cwd: string
  status: string
  running: number
}

// Discriminated on `op` for the success case (so each op's response only
// carries the fields that op actually has), collapsed to one shared shape
// for failure — the caller doesn't need to know which op failed to show
// `error`.
export type IpcResponse =
  | { op: 'status'; ok: true; pid: number; personaCount: number; uptimeMs: number }
  | { op: 'register'; ok: true }
  | { op: 'pause'; ok: true; found: boolean }
  | { op: 'unpause'; ok: true; found: boolean }
  | { op: 'forget'; ok: true; removed: boolean }
  | { op: 'list'; ok: true; personas: PersonaStatus[] }
  | { op: 'shutdown'; ok: true }
  | { ok: false; error: string }

// One request, one response, then the connection closes — request/response
// over JSON Lines (one JSON value per line), not a persistent multiplexed
// protocol. Every CLI command so far is "ask once, print the answer, exit"
// — nothing here needs a session, and keeping the daemon side stateless
// per-connection is simpler to get right than framing multiple in-flight
// requests over one socket would be.
export type IpcHandler = (request: IpcRequest) => IpcResponse | Promise<IpcResponse>

export function createIpcServer(handler: IpcHandler): net.Server {
  const server = net.createServer((socket) => {
    // Without this, a client that already gave up (its own
    // sendIpcRequest timeout, cli.ts) and destroyed its end of the
    // socket turns the eventual `socket.end()` below into an unhandled
    // EPIPE — an 'error' event with no listener crashes the whole daemon
    // process, not just this one connection. A slow handler makes this
    // easy to hit in practice, not just a theoretical race.
    socket.on('error', () => {})
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }
      const line = buffer.slice(0, newlineIndex)
      void Promise.resolve(handler(JSON.parse(line) as IpcRequest)).then((response) => {
        if (!socket.destroyed) {
          socket.end(JSON.stringify(response) + '\n')
        }
      })
    })
  })
  return server
}

// Binds the server to the platform address, clearing a stale socket file
// left behind by a daemon that didn't shut down cleanly (a crash, a killed
// process) — Windows named pipes need no such cleanup, they don't leave a
// filesystem entry behind.
export async function listenIpcServer(server: net.Server): Promise<void> {
  const address = ipcAddress()
  if (process.platform !== 'win32') {
    fs.mkdirSync(path.dirname(address), { recursive: true })
    if (fs.existsSync(address)) {
      const stale = await isAddressStale(address)
      if (stale) {
        fs.unlinkSync(address)
      }
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(address, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

function isAddressStale(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(address)
    probe.once('connect', () => {
      probe.destroy()
      resolve(false)
    })
    probe.once('error', () => resolve(true))
  })
}

// Used by every CLI command that needs the daemon — resolves to `null` rather than
// throwing when nothing is listening, so callers can print a plain "daemon
// isn't running" instead of an ECONNREFUSED stack trace.
export function sendIpcRequest(request: IpcRequest, timeoutMs = 2000): Promise<IpcResponse | null> {
  return new Promise((resolve) => {
    const socket = net.connect(ipcAddress())
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(null)
    }, timeoutMs)

    socket.once('connect', () => {
      socket.end(JSON.stringify(request) + '\n')
    })

    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
    })
    socket.once('close', () => {
      clearTimeout(timer)
      if (buffer.trim() === '') {
        resolve(null)
        return
      }
      resolve(JSON.parse(buffer) as IpcResponse)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}
