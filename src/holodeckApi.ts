import { CONNECTOR_USER_AGENT } from './holodeck.js'
import { refreshLoginTokens, TokenRequestError } from './holodeckLogin.js'
import { loadLoginCredential, saveLoginCredential, type LoginCredential } from './loginCredential.js'

// Client for Holodeck's `holodeck`-CLI API (HOL-132, backend/src/auth/
// cliApi.ts): with the person's login (`holodeck login`), list the Agents
// they own, and get a short-lived token scoped to exactly one of them. This
// is the only place that touches the login credential: it keeps it fresh
// (the access token lasts 1h, the refresh token 30 days) so callers - the
// setup commands, and later the long-running `channel run` and `headless`
// processes - just ask for what they need and never deal with expiry.

export class NotLoggedInError extends Error {
  constructor() {
    super('Not signed in. Run `holodeck login` first.')
  }
}

export class SessionExpiredError extends Error {
  constructor() {
    super('Your Holodeck login expired. Run `holodeck login` again.')
  }
}

// An answer from the server that isn't success. `code` is the backend's own
// machine-readable `error` (`agent_not_found`, `agent_type_mismatch`, ...).
export class HolodeckApiError extends Error {
  status: number
  code: string | undefined

  constructor(status: number, code: string | undefined, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export type AgentConnectionMode = 'session' | 'channel' | 'headless'

export interface AgentSummary {
  id: string
  name: string
  connectionMode: AgentConnectionMode
  // Who runs this Agent, on which model (HOL-138) and at which effort
  // (HOL-140). Null for a session Agent; a null model or effort means the
  // runner decides.
  vendor: string | null
  model: string | null
  effort: string | null
  // The Organization the Agent belongs to (HOL-149). Not used yet: there is one
  // Organization per person today; kept so the selectors can label Agents by it
  // once there can be several.
  organizationId: string
  organizationName: string
}

// Only modes a CLI process can run as - mirrors the backend's own purposes.
export type AgentTokenPurpose = 'channel' | 'headless'

// Refreshing this long before the access token actually expires, so a call
// that starts right at the boundary doesn't fail halfway.
const EXPIRY_MARGIN_MS = 60_000

// Turns the current login into a fresh one. If the refresh is *rejected*
// the login is over (SessionExpiredError); if the server is merely
// unreachable that error propagates as-is, without discarding anything.
async function refreshCredential(stale: LoginCredential): Promise<LoginCredential> {
  try {
    const tokens = await refreshLoginTokens(stale.serverUrl, stale.refreshToken)
    const fresh = { ...stale, ...tokens }
    saveLoginCredential(fresh)
    return fresh
  } catch (error) {
    if (!(error instanceof TokenRequestError)) {
      throw error
    }
    // Several processes share this one credential (each open Channel is its
    // own process): if another one refreshed first and the server rotated
    // the refresh token, ours is now spent - but the file holds the new one.
    const latest = loadLoginCredential()
    if (latest && latest.refreshToken !== stale.refreshToken) {
      return latest
    }
    throw new SessionExpiredError()
  }
}

async function currentCredential(): Promise<LoginCredential> {
  const credential = loadLoginCredential()
  if (!credential) {
    throw new NotLoggedInError()
  }
  return Date.now() >= credential.expiresAt - EXPIRY_MARGIN_MS ? refreshCredential(credential) : credential
}

async function apiFetch(pathAndQuery: string, body?: unknown): Promise<Response> {
  const send = (credential: LoginCredential) =>
    fetch(new URL(pathAndQuery, credential.serverUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        'user-agent': CONNECTOR_USER_AGENT,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })

  const credential = await currentCredential()
  const response = await send(credential)
  if (response.status !== 401) {
    return response
  }
  // The server disagrees with our clock (or revoked the token): one refresh
  // and one retry, then it is genuinely over.
  const retried = await send(await refreshCredential(credential))
  if (retried.status === 401) {
    throw new SessionExpiredError()
  }
  return retried
}

async function toApiError(response: Response): Promise<HolodeckApiError> {
  const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string }
  return new HolodeckApiError(
    response.status,
    payload.error,
    payload.message ?? `Holodeck answered ${response.status}${payload.error ? ` (${payload.error})` : ''}.`,
  )
}

// The Agents the signed-in person owns, optionally narrowed to one type -
// what every setup command's selector is built from.
export async function listMyAgents(connectionMode?: AgentConnectionMode): Promise<AgentSummary[]> {
  const query = connectionMode ? `?connectionMode=${connectionMode}` : ''
  const response = await apiFetch(`/cli/agents${query}`)
  if (!response.ok) {
    throw await toApiError(response)
  }
  return ((await response.json()) as { agents: AgentSummary[] }).agents
}

export interface AgentAccessToken {
  accessToken: string
  // Epoch ms.
  expiresAt: number
}

// Per process, per Agent: a long-running `channel run` asks on every
// (re)connect, and the token is good for an hour.
const agentTokenCache = new Map<string, AgentAccessToken>()

// A token scoped to one Agent, valid for `/mcp` and `/agent/events` - what
// `channel run` and `headless` actually talk to Holodeck with. The server
// refuses (403 `agent_type_mismatch`) when the Agent isn't of the type the
// purpose names, so a `session` Agent can't be run as a Channel even by a
// modified CLI.
export async function getAgentAccessToken(agentId: string, purpose: AgentTokenPurpose): Promise<AgentAccessToken> {
  const cached = agentTokenCache.get(agentId)
  if (cached && Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS) {
    return cached
  }
  const response = await apiFetch('/cli/agent-token', { agentId, purpose })
  if (!response.ok) {
    throw await toApiError(response)
  }
  const token = (await response.json()) as AgentAccessToken
  agentTokenCache.set(agentId, token)
  return token
}
