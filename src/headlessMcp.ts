import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { fetchAgentSession, withMcpClient } from './holodeck.js'
import { getAgentAccessToken, NotLoggedInError } from './holodeckApi.js'
import { loadLoginCredential } from './loginCredential.js'

// `holodeck headless mcp <agentId>` (hidden, HOL-131): the Holodeck MCP server
// a Headless run's `claude -p` spawns over stdio (headlessRun.ts's
// `--mcp-config`). It forwards Holodeck's tools for this Agent to `/mcp`,
// the same way a Channel does (channelServer.ts), for the same reason: an
// Agent token lasts an hour and a run can be longer, so the token is fetched
// (and renewed) here, from the person's login, and never written into the
// config file Claude Code reads.
//
// stdout is the MCP transport; nothing else may write to it.

// Connection plumbing a model must never call: nothing pushes health checks
// to this run, and a disconnect report would be meaningless here.
const HIDDEN_TOOLS = new Set(['report_health', 'report_disconnect'])

export async function runHeadlessMcp(agentId: string, version: string): Promise<void> {
  const login = loadLoginCredential()
  if (!login) {
    throw new NotLoggedInError()
  }
  const { serverUrl } = login
  const getToken = async () => (await getAgentAccessToken(agentId, 'headless')).accessToken

  // Holodeck's own instructions (how to use it, the Agent's persona) become
  // this server's, the text a session connected to /mcp directly gets.
  const { instructions } = await fetchAgentSession(serverUrl, await getToken())
  const mcp = new Server({ name: 'holodeck-agent', version }, { capabilities: { tools: {} }, instructions })

  mcp.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const listed = await withMcpClient(serverUrl, await getToken(), (client) => client.listTools(request.params))
    return { ...listed, tools: listed.tools.filter((tool) => !HIDDEN_TOOLS.has(tool.name)) }
  })
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (HIDDEN_TOOLS.has(request.params.name)) {
      return { isError: true, content: [{ type: 'text', text: `${request.params.name} isn't available in this session.` }] }
    }
    try {
      return await withMcpClient(serverUrl, await getToken(), (client) => client.callTool(request.params))
    } catch (error) {
      // A result the model can read, rather than a protocol error it can't.
      process.stderr.write(`tool call ${request.params.name} failed: ${String(error)}\n`)
      return { isError: true, content: [{ type: 'text', text: `Couldn't reach Holodeck: ${String(error)}` }] }
    }
  })

  await mcp.connect(new StdioServerTransport())
  // Claude Code ending the run closes stdin; the SDK's transport doesn't exit
  // on that by itself (channelServer.ts found the same).
  const exit = () => process.exit(0)
  mcp.onclose = exit
  process.stdin.once('end', exit)
  process.stdin.once('close', exit)
}
