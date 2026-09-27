import fs from 'node:fs'
import path from 'node:path'
import { configDir } from './paths.js'

// One Agent that works in the background on this machine (HOL-131: a Holodeck
// Agent of type `headless`), as persisted to disk so a daemon restart or a
// reboot brings it back without running `holodeck agent setup` again. Holds no
// secret: the daemon asks Holodeck for a short-lived Agent token when it needs
// one (holodeckApi.ts's getAgentAccessToken), using the person's own login.
export interface PersonaRecord {
  agentId: string
  // The Agent's name when it was set up, only for display (Holodeck is the
  // source of truth; `agent list` shows the current one).
  name: string
  // The folder its runs work in: a git repository (each run gets its own
  // worktree of it) or a plain folder (runs one at a time, in place).
  cwd: string
  // `holodeck agent pause`: the daemon keeps the record but stops taking new
  // work for this Agent (runs already going finish), including after a
  // daemon restart, until `holodeck agent start`. Undefined/false = active.
  paused?: boolean
}

interface PersonaStoreFile {
  personas: unknown[]
}

function storeFilePath(): string {
  return path.join(configDir, 'personas.json')
}

function isPersonaRecord(value: unknown): value is PersonaRecord {
  const record = value as Partial<PersonaRecord> | null
  return typeof record?.agentId === 'string' && typeof record.name === 'string' && typeof record.cwd === 'string'
}

// Records of the old daemon model (a static Agent token plus a persistent SDK
// session, removed in HOL-131) have no `agentId`; they are skipped here and
// dropped on the next save.
export function loadPersonas(): PersonaRecord[] {
  const filePath = storeFilePath()
  if (!fs.existsSync(filePath)) {
    return []
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as PersonaStoreFile
  return parsed.personas.filter(isPersonaRecord)
}

function savePersonas(personas: PersonaRecord[]): void {
  const filePath = storeFilePath()
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const payload: PersonaStoreFile = { personas }
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2))
}

// Adds an Agent, or replaces the one with the same id: setting an Agent up
// again (a new folder, say) updates it in place.
export function upsertPersona(record: PersonaRecord): void {
  const personas = loadPersonas().filter((p) => p.agentId !== record.agentId)
  personas.push(record)
  savePersonas(personas)
}

export function removePersona(agentId: string): void {
  savePersonas(loadPersonas().filter((p) => p.agentId !== agentId))
}
