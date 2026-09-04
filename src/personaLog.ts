import fs from 'node:fs'
import path from 'node:path'
import { dataDir } from './paths.js'

// Where a persona's session activity is captured (HOL-57's own "logs
// needs an actual place to capture output first" note) — one JSONL file
// per persona under the data dir, alongside the daemon's PID file. Raw
// `SDKMessage` objects, one per line, not yet reformatted into anything
// human-friendly — good enough for `holodeck logs <persona>` to exist for
// real; a nicer renderer is a natural follow-up, not required to prove
// the capture point works.
function logFilePath(personaName: string): string {
  return path.join(dataDir, 'logs', `${personaName}.log`)
}

// A persona's session runs indefinitely, so this file has no natural end
// — without a cap it grows forever (every `SDKMessage`, including a full
// tool list on each `system/init`, e.g. after every `restart`). Kept as
// one truncated-to-tail file rather than logrotate-style numbered
// archives: this is a live debug tail (`holodeck logs`), not an audit
// trail anything needs to keep historically.
const MAX_LOG_BYTES = 5 * 1024 * 1024
// Only actually truncates once a full MB past the cap, not on every
// single append past it — turns an O(size) read+rewrite into an
// occasional cost instead of one on every append once oversized.
const TRUNCATE_SLACK_BYTES = 1 * 1024 * 1024

// Drops the oldest bytes, keeping the most recent `maxBytes` — and drops
// one more partial line after that so the file starts on a clean JSONL
// boundary instead of a truncated first line `readLog`/`followLog`
// couldn't parse.
function truncateToTail(filePath: string, maxBytes: number): void {
  const size = fs.statSync(filePath).size
  const start = size - maxBytes
  const buffer = Buffer.alloc(maxBytes)
  const fd = fs.openSync(filePath, 'r')
  try {
    fs.readSync(fd, buffer, 0, maxBytes, start)
  } finally {
    fs.closeSync(fd)
  }
  const text = buffer.toString('utf8')
  const firstNewline = text.indexOf('\n')
  fs.writeFileSync(filePath, firstNewline === -1 ? text : text.slice(firstNewline + 1))
}

export function appendLog(personaName: string, entry: unknown): void {
  const filePath = logFilePath(personaName)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_LOG_BYTES + TRUNCATE_SLACK_BYTES) {
    truncateToTail(filePath, MAX_LOG_BYTES)
  }
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`)
}

export function readLog(personaName: string): string {
  const filePath = logFilePath(personaName)
  if (!fs.existsSync(filePath)) {
    return ''
  }
  return fs.readFileSync(filePath, 'utf8')
}

export function logFileExists(personaName: string): boolean {
  return fs.existsSync(logFilePath(personaName))
}

// Removes a persona's log entirely — called by `agent forget` (daemon.ts,
// a name that's genuinely gone shouldn't leave old activity behind for
// whatever gets registered under that name next) and by `holodeck logs
// <persona> --clear` (a manual reset while iterating/testing, no need to
// forget the persona itself just to start its log over).
export function deleteLog(personaName: string): void {
  const filePath = logFilePath(personaName)
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
}

// Polling tail (`holodeck logs <persona> --follow`) — simpler than a
// real IPC streaming channel, and fine for the write volume one persona's
// session produces. Calls `onLine` for every line appended since the
// last check; never resolves on its own (the caller aborts it).
export async function followLog(personaName: string, onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
  const filePath = logFilePath(personaName)
  let position = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0

  while (!signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (!fs.existsSync(filePath)) {
      continue
    }
    const size = fs.statSync(filePath).size
    // Smaller than last time means `appendLog`'s truncate-to-tail kicked
    // in since we last checked — `position` now points past the end of
    // the (shrunk) file, so resume from the start instead of sitting
    // stuck forever waiting for `size` to grow back past the old value.
    if (size < position) {
      position = 0
    }
    if (size <= position) {
      continue
    }
    const stream = fs.createReadStream(filePath, { start: position, end: size - 1, encoding: 'utf8' })
    let chunk = ''
    for await (const piece of stream) {
      chunk += piece as string
    }
    position = size
    for (const line of chunk.split('\n')) {
      if (line.trim() !== '') {
        onLine(line)
      }
    }
  }
}
