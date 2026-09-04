import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './paths.js'
import { DEFAULT_SERVER_URL } from './holodeck.js'

// The Holodeck server every persona on this machine talks to — one daemon,
// one server (unlike the Holodeck token, which is per-persona). Set once
// via `holodeck config set-server`, not re-asked on every `register`.
//
// `claudeToken` (HOL-57) is a `CLAUDE_CODE_OAUTH_TOKEN` — minted once via
// `claude setup-token`, machine-wide like serverUrl (one Claude
// subscription covers every persona registered here, for v1 — see
// PLAN.md 9's Agent SDK auth decision). Same sensitivity class as a
// bearer token, so this file gets the same 0600 restriction store.ts's
// personas.json already has, unlike before this field existed (serverUrl
// alone wasn't sensitive enough to bother).
interface ConfigFile {
  serverUrl?: string
  claudeToken?: string
}

function configFilePath(): string {
  return path.join(configDir, 'config.json')
}

function restrictPermissions(filePath: string): void {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o600)
  }
}

function loadConfig(): ConfigFile {
  const filePath = configFilePath()
  if (!fs.existsSync(filePath)) {
    return {}
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ConfigFile
}

// Read-merge-write, not a blind overwrite — `setServerUrl` and
// `setClaudeToken` each touch one field of the same file, and an earlier
// version of this module lost whichever field wasn't being set that call
// (`setServerUrl` rewrote the whole file with only `serverUrl`).
function saveConfig(patch: Partial<ConfigFile>): void {
  const filePath = configFilePath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const payload: ConfigFile = { ...loadConfig(), ...patch }
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2))
  restrictPermissions(filePath)
}

export function loadServerUrl(): string {
  return loadConfig().serverUrl ?? DEFAULT_SERVER_URL
}

export function setServerUrl(serverUrl: string): void {
  saveConfig({ serverUrl })
}

export function loadClaudeToken(): string | undefined {
  return loadConfig().claudeToken
}

export function setClaudeToken(claudeToken: string): void {
  saveConfig({ claudeToken })
}
