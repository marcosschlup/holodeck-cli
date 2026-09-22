import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './paths.js'
import { checkForUpdate } from './update.js'

// The daily "an update exists" nudge (HOL-156, Holodeck CLI distribution
// Intention, task-manager repo) for `login`, `agent setup` and `agent
// start` — never `channel run`, whose stdout IS the MCP stdio channel;
// printing anything there breaks the protocol, so no caller of this module
// may ever be that command.
//
// Cached next to the existing config/personas files (`configDir`, not
// `dataDir`): a "last checked" timestamp is exactly that kind of small,
// persistent setting, not the ephemeral runtime state (PID file, IPC
// socket) `dataDir` holds.
const CACHE_PATH = path.join(configDir, 'update-check.json')
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
// Bounds how long a command can be held up by this — a courtesy nudge must
// never make `login`/`agent setup`/`agent start` feel hung on a slow or
// dead network.
const CHECK_TIMEOUT_MS = 3000

interface Cache {
  lastCheckedAt: number
}

function loadCache(): Cache | undefined {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) as Cache
  } catch {
    return undefined
  }
}

function saveCache(cache: Cache): void {
  try {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache))
  } catch {
    // Best-effort: worst case this checks again next time instead of
    // waiting out the day, which is harmless.
  }
}

// Prints "holodeck X is available, run: holodeck update" when (and only
// when) a newer release exists and the last check was over a day ago.
// Silent on everything else — a stale/corrupt cache, a network failure, a
// GitHub API rate limit, `HOLODECK_NO_UPDATE_CHECK` set — all mean "no
// news," never an error surfaced to the person running an unrelated
// command.
export async function maybeNoticeUpdate(currentVersion: string): Promise<void> {
  if (process.env.HOLODECK_NO_UPDATE_CHECK) {
    return
  }
  const cache = loadCache()
  if (cache && Date.now() - cache.lastCheckedAt < CHECK_INTERVAL_MS) {
    return
  }
  // Recorded before the network call, not after: a slow or failing check
  // shouldn't retry on every single command in between, only once the
  // interval has genuinely passed again.
  saveCache({ lastCheckedAt: Date.now() })
  try {
    const status = await checkForUpdate(currentVersion, AbortSignal.timeout(CHECK_TIMEOUT_MS))
    if (status.hasUpdate) {
      console.log(`holodeck ${status.latestVersion} is available, run: holodeck update`)
    }
  } catch {
    // Network failure, timeout, or a rate-limited GitHub API — no news
    // either way.
  }
}
