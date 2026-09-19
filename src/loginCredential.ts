import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './paths.js'

// The one credential `holodeck login` leaves on this machine (HOL-128,
// reshaped by HOL-132): the *person's* login to a Holodeck server - not one
// per Agent. Everything Agent-specific (which Agents exist, a token scoped
// to one of them) is asked of the server on demand (holodeckApi.ts), using
// this. So there is exactly one, and logging in again just replaces it.
export interface LoginCredential {
  serverUrl: string
  accessToken: string
  refreshToken: string
  // Epoch ms - compared against Date.now() to decide whether to refresh
  // proactively before a call, rather than only reactively on a 401.
  expiresAt: number
}

function credentialFilePath(): string {
  return path.join(configDir, 'login.json')
}

// HOL-128's first shape: one credential per Agent, picked in the browser at
// login. Superseded, and its tokens are still live credentials, so the old
// file is deleted rather than left behind.
function legacyAgentCredentialsPath(): string {
  return path.join(configDir, 'oauth-credentials.json')
}

// Same sensitivity class as store.ts's PersonaRecord.token - see that
// file's own comment on why this is a permission-restricted file instead
// of an OS keychain.
function restrictPermissions(filePath: string): void {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o600)
  }
}

export function loadLoginCredential(): LoginCredential | undefined {
  const filePath = credentialFilePath()
  if (!fs.existsSync(filePath)) {
    return undefined
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as LoginCredential
}

export function saveLoginCredential(credential: LoginCredential): void {
  const filePath = credentialFilePath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(credential, null, 2))
  restrictPermissions(filePath)
  fs.rmSync(legacyAgentCredentialsPath(), { force: true })
}

export function removeLoginCredential(): void {
  fs.rmSync(credentialFilePath(), { force: true })
}
