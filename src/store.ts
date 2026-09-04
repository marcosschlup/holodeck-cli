import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './paths.js'

// One registered persona, as persisted to disk (PLAN.md 9, "Registered
// personas must survive a daemon restart"). `name` is the Agent's own
// name in Holodeck, not a locally-invented alias (HOL-52's own CLI
// design decision) — HOL-54 is what actually resolves it for real via
// Holodeck (get_my_context); this module only stores whatever name it's
// given.
export interface PersonaRecord {
  name: string
  token: string
  cwd?: string
  // Claude model this persona's session uses (HOL-57 follow-up) — chosen
  // in the `register` wizard from `Query.supportedModels()`'s live list,
  // e.g. `'sonnet'`. Undefined means whatever the Claude Agent SDK
  // defaults to on its own.
  model?: string
  // `holodeck stop <persona>` pauses rather than forgets (decided after
  // HOL-55: a persona's token is only ever shown once by Holodeck itself,
  // so silently requiring it again to bring a persona back was a rough
  // edge) — the token stays here, this just marks that the daemon
  // shouldn't auto-connect it on its own next start, only on an explicit
  // `holodeck start <persona>`. `holodeck forget <persona>` is the actual
  // removal. Undefined/false = active, same as before this field existed.
  paused?: boolean
}

interface PersonaStoreFile {
  personas: PersonaRecord[]
}

function storeFilePath(): string {
  return path.join(configDir, 'personas.json')
}

// Holds bearer tokens, same sensitivity class as a GitHub PAT — restricted
// to the owning user (POSIX file mode 0600). Considered an OS keychain
// instead (PLAN.md 9 left this open): every real cross-platform option
// (e.g. cross-keychain, the keytar successor) still leans on native
// addons per OS, which fights the SEA single-binary packaging goal this
// whole CLI is built around (PLAN.md 9, "Distribution/packaging"). A
// plain, permission-restricted config file is the same posture several
// major CLIs already ship with (npm's own auth tokens, AWS CLI
// credentials) — revisit if that trade-off stops being acceptable.
function restrictPermissions(filePath: string): void {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o600)
  }
}

export function loadPersonas(): PersonaRecord[] {
  const filePath = storeFilePath()
  if (!fs.existsSync(filePath)) {
    return []
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PersonaStoreFile
  return parsed.personas
}

function savePersonas(personas: PersonaRecord[]): void {
  const filePath = storeFilePath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const payload: PersonaStoreFile = { personas }
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2))
  restrictPermissions(filePath)
}

// Adds a new persona, or replaces the existing one with the same name —
// re-registering the same Agent's token (e.g. after `regenerateToken` in
// Holodeck) updates it in place rather than leaving a stale duplicate.
export function upsertPersona(record: PersonaRecord): void {
  const personas = loadPersonas().filter((p) => p.name !== record.name)
  personas.push(record)
  savePersonas(personas)
}

export function removePersona(name: string): void {
  savePersonas(loadPersonas().filter((p) => p.name !== name))
}
