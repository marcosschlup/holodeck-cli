import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Holodeck's own frontend defaults to this same address when no explicit
// config is given (PLAN.md 9's SignIn.tsx note, `VITE_API_URL ?? 'http://localhost:3000'`)
// — the local backend's dev default, not a hosted service this CLI assumes exists.
export const DEFAULT_SERVER_URL = 'http://localhost:3000'

// Identifies requests as coming from this CLI, not a browser or some other
// MCP client — standard `User-Agent`, not a custom header, so it shows up
// for free in whatever the server already logs/analyzes per-request rather
// than needing bespoke parsing. Reused by every HTTP call this module (and
// the /agent/events SSE client, HOL-55) makes to Holodeck.
export const CONNECTOR_USER_AGENT = `holodeck-agent-connector/0.0.0 (node/${process.version}; ${process.platform})`

export interface AgentIdentity {
  agentId: string
  agentName: string
  ownerId: string
  ownerName: string
  instructions: string
}

// Every MCP call this CLI makes is a one-shot connect/call/close — the
// server itself is stateless per request (a fresh McpServer + transport
// per POST, `sessionIdGenerator: undefined`, backend/src/app.ts), so there's
// no session worth keeping a client open across calls for.
async function withMcpClient<T>(serverUrl: string, token: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', serverUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, 'User-Agent': CONNECTOR_USER_AGENT } },
  })
  const client = new Client({ name: 'holodeck-agent-connector', version: '0.0.0' })
  await client.connect(transport)
  try {
    return await fn(client)
  } finally {
    await client.close()
  }
}

// Calls a no-argument MCP tool and parses its JSON text result — every
// tool this CLI calls (get_my_context, report_health, report_disconnect)
// takes no arguments and returns `jsonResult(...)` shaped JSON
// (backend/src/mcp/server.ts's own helper).
async function callJsonTool<T>(serverUrl: string, token: string, name: string): Promise<T> {
  return withMcpClient(serverUrl, token, async (client) => {
    const result = await client.callTool({ name, arguments: {} })
    const content = result.content as { type: string; text: string }[]
    return JSON.parse(content[0]!.text) as T
  })
}

// Same identity a session Agent gets handed at connection time, resolved
// here purely to prove the token is valid and to get a real name to
// register with instead of a placeholder (HOL-54). Throws on an invalid
// token or an unreachable server — the caller decides how to report that.
export function resolveAgentIdentity(serverUrl: string, token: string): Promise<AgentIdentity> {
  return callJsonTool<AgentIdentity>(serverUrl, token, 'get_my_context')
}

export interface HealthReport {
  ok: boolean
  uptimeMs: number | null
}

// Answers a health_check pushed over /agent/events (HOL-55) — the
// connectionMode: connector-only tool backend/src/mcp/server.ts registers.
export function reportHealth(serverUrl: string, token: string): Promise<HealthReport> {
  return callJsonTool<HealthReport>(serverUrl, token, 'report_health')
}

// Tells Holodeck this Agent's connection is closing on purpose, right
// before actually closing it — flips it offline immediately instead of
// waiting out the heartbeat's 5-minute grace window (PLAN.md 9, decided
// during HOL-54/55). Errors are the caller's problem to decide how to
// handle (best-effort: the connection is going away regardless).
export async function reportDisconnect(serverUrl: string, token: string): Promise<void> {
  await callJsonTool<{ ok: boolean }>(serverUrl, token, 'report_disconnect')
}
