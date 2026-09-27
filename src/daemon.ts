import fs from 'node:fs'
import path from 'node:path'
import { loadServerUrl } from './config.js'
import { startHeadlessWorker, type HeadlessWorker } from './headlessWorker.js'
import { loadLoginCredential } from './loginCredential.js'
import { createIpcServer, listenIpcServer, pidFilePath, type IpcRequest, type IpcResponse } from './ipc.js'
import { dataDir } from './paths.js'
import { deleteRunHistory } from './runHistory.js'
import { loadPersonas, removePersona, upsertPersona, type PersonaRecord } from './store.js'

// The daemon: one background process per machine that keeps this machine's
// Headless Agents working (HOL-131). Each Agent is a HeadlessWorker
// (headlessWorker.ts) that claims Tasks from Holodeck's queue and runs them as
// `claude -p` processes. Started detached by `holodeck agent setup` /
// `agent start` (cli.ts's ensureDaemonRunning), or with `holodeck start
// --foreground`; the CLI talks to it over a local socket (ipc.ts).
//
// Until HOL-131 the daemon held a persistent Agent SDK session per Agent,
// registered with a static token (`holodeck register`); that model was dropped
// (HOL-127), along with its commands.

// The Agents this machine runs, from the store (store.ts), kept in step with
// it on every change so `list` never reads the disk.
const personas = new Map<string, PersonaRecord>()
const workers = new Map<string, HeadlessWorker>()

// Every Agent talks to the Holodeck the person is signed in to (the Agent
// token comes from that login), falling back to `config set-server`.
let serverUrl = ''

// The daemon has no terminal: its own status lines (connections, runs
// starting and ending) go to a file, rotated like a Channel's.
const MAX_LOG_BYTES = 1_000_000
function createDaemonLogger(): (message: string) => void {
  const filePath = path.join(dataDir, 'daemon.log')
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_LOG_BYTES) {
      fs.rmSync(`${filePath}.1`, { force: true })
      fs.renameSync(filePath, `${filePath}.1`)
    }
  } catch {
    // Best effort, like every write below.
  }
  return (message) => {
    try {
      fs.appendFileSync(filePath, `${new Date().toISOString()} ${message}\n`)
    } catch {
      // A log that can't be written must never take the daemon down.
    }
  }
}
const log = createDaemonLogger()

function start(record: PersonaRecord): void {
  const existing = workers.get(record.agentId)
  if (existing) {
    existing.resume()
    return
  }
  workers.set(record.agentId, startHeadlessWorker(record, serverUrl, log))
}

function save(record: PersonaRecord): void {
  personas.set(record.agentId, record)
  upsertPersona(record)
}

async function handleRequest(request: IpcRequest, startedAt: number, shutdown: () => Promise<void>): Promise<IpcResponse> {
  switch (request.op) {
    case 'status':
      return { op: 'status', ok: true, pid: process.pid, personaCount: personas.size, uptimeMs: Date.now() - startedAt }
    case 'register': {
      // Setting an Agent up again (another folder) replaces its worker: runs
      // going in the old folder end first.
      const previous = personas.get(request.agentId)
      if (previous && previous.cwd !== request.cwd) {
        await workers.get(request.agentId)?.shutdown('The Agent was set up in another folder on this machine.')
        workers.delete(request.agentId)
      }
      const record: PersonaRecord = { agentId: request.agentId, name: request.name, cwd: request.cwd }
      save(record)
      start(record)
      return { op: 'register', ok: true }
    }
    case 'pause': {
      const record = personas.get(request.agentId)
      if (!record) {
        return { op: 'pause', ok: true, found: false }
      }
      save({ ...record, paused: true })
      await workers.get(request.agentId)?.pause()
      return { op: 'pause', ok: true, found: true }
    }
    case 'unpause': {
      const record = personas.get(request.agentId)
      if (!record) {
        return { op: 'unpause', ok: true, found: false }
      }
      const resumed: PersonaRecord = { ...record, paused: false }
      save(resumed)
      start(resumed)
      return { op: 'unpause', ok: true, found: true }
    }
    case 'forget': {
      const removed = personas.delete(request.agentId)
      removePersona(request.agentId)
      const worker = workers.get(request.agentId)
      workers.delete(request.agentId)
      await worker?.shutdown('The Agent was removed from this machine (holodeck agent forget) before the run finished.')
      deleteRunHistory(request.agentId)
      return { op: 'forget', ok: true, removed }
    }
    case 'list':
      return {
        op: 'list',
        ok: true,
        personas: [...personas.values()].map((record) => {
          const worker = workers.get(record.agentId)
          return {
            agentId: record.agentId,
            name: record.name,
            cwd: record.cwd,
            status: record.paused ? 'paused' : (worker?.status() ?? 'connecting'),
            running: worker?.running() ?? 0,
          }
        }),
      }
    case 'shutdown':
      // Responds first, then shuts down on the next tick, so the caller sees
      // the "ok" before the socket goes away.
      setImmediate(() => void shutdown())
      return { op: 'shutdown', ok: true }
  }
}

// Resolves once the IPC server is listening; the process then keeps running
// (the listening socket holds the event loop open) until a signal or the
// `shutdown` op.
export async function runDaemon(): Promise<void> {
  const startedAt = Date.now()

  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(pidFilePath(), String(process.pid))

  serverUrl = loadLoginCredential()?.serverUrl ?? loadServerUrl()
  log(`daemon started (pid ${process.pid}, ${serverUrl})`)

  // Every Agent set up on this machine comes back after a restart or a reboot;
  // a paused one stays paused until `holodeck agent start`.
  for (const record of loadPersonas()) {
    personas.set(record.agentId, record)
    if (!record.paused) {
      start(record)
    }
  }

  // A deliberate stop ends the runs going and reports them to Holodeck as
  // failed, so their Tasks are blocked with a clear reason right away instead
  // of five minutes later as "lost". A killed or crashed daemon can't do this;
  // that is what the lease on the server is for.
  const shutdown = async () => {
    log('daemon stopping')
    await Promise.all(
      [...workers.values()].map((worker) => worker.shutdown('The Holodeck daemon on the machine running it was stopped before the run finished.')),
    )
    server.close(() => process.exit(0))
  }
  const server = createIpcServer((request) => handleRequest(request, startedAt, shutdown))
  await listenIpcServer(server)

  // Tells whoever spawned this process (cli.ts's `ensureDaemonRunning`) that
  // the IPC server is up. Only exists when started detached with an IPC
  // channel; a no-op for `--foreground`.
  process.send?.('ready')

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}
