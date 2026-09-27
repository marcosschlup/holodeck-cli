import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from './paths.js'

// What `holodeck logs` shows for a Headless Agent (HOL-131, HOL-127's
// redesign): one record per run, plus that run's raw Claude Code stream for
// digging into one. Per Agent, under the data dir.

export interface RunRecord {
  entryId: string
  taskDisplayId: string
  taskTitle: string
  trigger: string
  startedAt: string
  endedAt: string
  exitCode: number | null
  success: boolean
  // Why it failed, as reported to Holodeck.
  reason?: string
  costUsd?: number
  turns?: number
  permissionMode?: string
  permissionDenials?: number
  // Where the run worked, and whether its worktree is still there (uncommitted
  // changes) or could not be removed.
  cwd?: string
  worktree?: 'none' | 'removed' | 'kept' | 'cleanup_failed'
  // The server no longer counted this run as running (it went silent too
  // long), so the daemon stopped it.
  stoppedByServer?: boolean
}

// Raw streams are the big part; the records themselves are small.
const KEPT_STREAMS = 50

function agentDir(agentId: string): string {
  return path.join(dataDir, 'headless', agentId)
}

function recordsFile(agentId: string): string {
  return path.join(agentDir(agentId), 'runs.jsonl')
}

export function streamFilePath(agentId: string, entryId: string): string {
  return path.join(agentDir(agentId), 'streams', `${entryId}.jsonl`)
}

function pruneStreams(agentId: string): void {
  const dir = path.dirname(streamFilePath(agentId, 'x'))
  if (!fs.existsSync(dir)) {
    return
  }
  const files = fs
    .readdirSync(dir)
    .map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const file of files.slice(KEPT_STREAMS)) {
    fs.rmSync(path.join(dir, file.name), { force: true })
  }
}

// Records are small (a few hundred bytes), but an Agent that works for months
// would still grow the file forever: past this size only the newest half is
// kept.
const MAX_RECORDS_BYTES = 2_000_000

export function appendRunRecord(agentId: string, record: RunRecord): void {
  fs.mkdirSync(agentDir(agentId), { recursive: true })
  const file = recordsFile(agentId)
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`)
  if (fs.statSync(file).size > MAX_RECORDS_BYTES) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
    fs.writeFileSync(file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`)
  }
  pruneStreams(agentId)
}

// The latest `limit` runs, newest first.
export function readRunRecords(agentId: string, limit: number): RunRecord[] {
  const file = recordsFile(agentId)
  if (!fs.existsSync(file)) {
    return []
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RunRecord)
    .reverse()
    .slice(0, limit)
}

export function deleteRunHistory(agentId: string): void {
  fs.rmSync(agentDir(agentId), { recursive: true, force: true })
}
