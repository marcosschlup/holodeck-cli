import fs from 'node:fs'
import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createActivityReporter, TRACKED_TASK_TOOLS } from './agentActivity.js'
import { startPersonaConnection } from './agentConnection.js'
import {
  describeChannelConnected,
  describeChannelEvent,
  describeChannelStopped,
  shouldReconcileOnConnect,
  type ChannelEvent,
  type ChannelNotification,
} from './channelEvents.js'
import { fetchAgentSession, withMcpClient } from './holodeck.js'
import { getAgentAccessToken, NotLoggedInError } from './holodeckApi.js'
import { loadLoginCredential } from './loginCredential.js'
import { dataDir } from './paths.js'

// `holodeck channel run <agentId>` (HOL-130): a Claude Code Channel - an MCP
// server Claude Code itself spawns over stdio (from the per-Agent config file
// `channel add` wrote under `.holodeck/`) that does two things for the session:
//   1. pushes Holodeck's events in as `<channel>` tags, so a Task assigned to
//      the Agent reaches it live instead of being polled for;
//   2. exposes Holodeck's own MCP tools for this Agent, by forwarding to
//      Holodeck's `/mcp` with the Agent's token. A `channel` Agent can't be
//      connected through the OAuth picker (that is for `session` Agents,
//      HOL-132), so without this the session would receive events it has no
//      way to act on. One config entry, and the token is renewed here,
//      never written into that file.
//
// stdout belongs to the MCP transport, so NOTHING else may write to it -
// every status line goes to stderr (where Claude Code's `--debug` log picks
// it up). One process per Claude Code session: there is no daemon to talk
// to, and two sessions never share a Channel process.

// Holodeck's connection-plumbing tools: this process already does both jobs
// itself (answers every `health_check`, reports the disconnect on the way
// out). Kept out of the model's reach because calling `report_disconnect`
// would flip the Agent offline while it is still connected.
const CHANNEL_HANDLED_TOOLS = new Set(['report_health', 'report_disconnect'])

// "Agent live activity" Intention, Task 3/7 (HOL-163): the tool `agent
// start`'s own `--settings` hooks call into (agentCommands.ts builds that
// config; this is the name both sides must agree on). Never returned by
// ListToolsRequestSchema below — it isn't one of Holodeck's own tools, so it
// was never going to appear there regardless, but it's still worth a tool
// name the model would recognize as internal if it ever saw it some other
// way. A CallToolRequestSchema call for it is handled directly, before the
// `replaced`/CHANNEL_HANDLED_TOOLS checks: it's about this session's own
// activity, not about acting as the Agent, so it keeps working even once
// this session has been replaced.
export const ACTIVITY_HOOK_TOOL = 'agent_activity_hook'

// Found by a real end-to-end run, not in the docs (the spike's own "must it
// be listed?" question, left open): Claude Code checks an `mcp_tool` hook's
// `tool` name against this server's own `tools/list` BEFORE ever issuing
// `tools/call` — an unlisted name fails client-side (`Tool ... not found`)
// without this process seeing the call at all. So this DOES have to appear
// below, unlike CHANNEL_HANDLED_TOOLS' own entries (those are real Holodeck
// tools already listed by Holodeck itself). The description is the only
// defense against the MODEL calling it directly (the CallToolRequestSchema
// branch above would just no-op on args it doesn't recognize either way,
// but it's better if the model never reaches for it in the first place).
const ACTIVITY_HOOK_TOOL_DESCRIPTOR = {
  name: ACTIVITY_HOOK_TOOL,
  description: "Internal: used by this session's own hooks to report activity. Not for the model to call.",
  inputSchema: {
    type: 'object' as const,
    properties: {
      kind: { type: 'string' },
      sessionId: { type: 'string' },
      promptId: { type: 'string' },
      toolName: { type: 'string' },
      toolUseId: { type: 'string' },
      durationMs: { type: 'string' },
    },
  },
}

const REPLACED_TOOL_MESSAGE =
  'This session was replaced: another session is now running this Agent, so its Holodeck tools are disabled here.'

// A Channel logs a line every 2 minutes (the health_check answer) plus its
// connection events, roughly 3 KB an hour: harmless in a session, but a file
// per Agent that nothing ever trimmed would grow for as long as the Agent is
// used. So it is rotated when a Channel starts: past this size the current
// file becomes `.1` (replacing the previous one) and a fresh one begins,
// which caps the total at about twice this, per Agent.
const MAX_LOG_BYTES = 1_000_000

// stderr (Claude Code's `--debug` log picks it up) AND a file per Agent:
// nobody runs a Channel with --debug on, and "why did it reconnect?" or "did
// that event arrive?" can't be answered afterwards from a stream that was
// never kept. Best effort: a log that can't be written must never take the
// Channel down.
function createLogger(agentId: string): (message: string) => void {
  const filePath = path.join(dataDir, `channel-${agentId}.log`)
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_LOG_BYTES) {
      fs.rmSync(`${filePath}.1`, { force: true })
      fs.renameSync(filePath, `${filePath}.1`)
    }
  } catch {
    // Falls through: the appends below fail the same way and are ignored.
  }
  return (message) => {
    process.stderr.write(`${message}\n`)
    try {
      fs.appendFileSync(filePath, `${new Date().toISOString()} ${message}\n`)
    } catch {
      // See above.
    }
  }
}

// What the model needs to make sense of the `<channel>` tags. Holodeck's own
// `instructions` (how to use Holodeck, this Agent's persona) come after it:
// the same text a session connected to /mcp directly would have been given.
function buildInstructions(agentName: string, holodeckInstructions: string | undefined): string {
  const channelInstructions = [
    `You are connected to Holodeck as the Agent "${agentName}". Holodeck pushes events to you as <channel ... event="..."> tags: a subscription of yours matched a Task, your owner sent you a direct instruction, someone tagged you in a note, a scheduled check of yours is due, your own setup changed (instructions edited, added to or removed from a project), or you just connected and should check what's pending.`,
    "Each event body names the Holodeck tool to reach for. Those tools are available in this session through this same server: they act as this Agent, and their names are Holodeck's own (list_tasks, get_task, add_interaction, set_resolution, ...). Nothing you write in the conversation reaches Holodeck by itself; only calling those tools does.",
  ].join('\n\n')
  return holodeckInstructions ? `${channelInstructions}\n\n---\n\n${holodeckInstructions}` : channelInstructions
}

export async function runChannel(agentId: string, version: string): Promise<void> {
  const login = loadLoginCredential()
  if (!login) {
    throw new NotLoggedInError()
  }
  const { serverUrl } = login
  const log = createLogger(agentId)
  const getToken = async () => (await getAgentAccessToken(agentId, 'channel')).accessToken

  // Before anything is served: proves the Agent can run as a Channel right now
  // (exists, right type, still owned) and gives its name and Holodeck's
  // instructions. A failure here exits non-zero, which Claude Code shows as
  // this server being `failed` in `/mcp`.
  const { identity, instructions: holodeckInstructions } = await fetchAgentSession(serverUrl, await getToken())
  const activity = createActivityReporter(serverUrl, getToken, log)

  const mcp = new Server(
    { name: 'holodeck-channel', version },
    {
      // The `claude/channel` key is what makes this a channel; `tools` is
      // the forwarding of Holodeck's tools described above.
      capabilities: { experimental: { 'claude/channel': {} }, tools: { listChanged: true } },
      instructions: buildInstructions(identity.agentName, holodeckInstructions),
    },
  )

  // Set once another session takes this Agent over (below). From then on this
  // session's Holodeck tools are off: only one session may act as an Agent at
  // a time, and a replaced one that could still call tools would be acting as
  // the Agent in parallel with the session that now holds it.
  let replaced = false

  // Forwarded as-is, on a fresh Holodeck connection per request (Holodeck's
  // MCP endpoint is stateless, holodeck.ts's own note): the tool set and each
  // tool's schema are whatever Holodeck says for THIS Agent (a channel Agent
  // gets tools a session Agent doesn't), with nothing duplicated here to keep
  // in sync. The token is asked for each time, so expiry never shows up as a
  // failed call.
  mcp.setRequestHandler(ListToolsRequestSchema, async (request) => {
    if (replaced) {
      return { tools: [] }
    }
    const listed = await withMcpClient(serverUrl, await getToken(), (client) => client.listTools(request.params))
    return {
      ...listed,
      tools: [...listed.tools.filter((tool) => !CHANNEL_HANDLED_TOOLS.has(tool.name)), ACTIVITY_HOOK_TOOL_DESCRIPTOR],
    }
  })
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === ACTIVITY_HOOK_TOOL) {
      return activity.handleHookCall((request.params.arguments ?? {}) as Record<string, unknown>)
    }
    if (replaced) {
      return { isError: true, content: [{ type: 'text', text: REPLACED_TOOL_MESSAGE }] }
    }
    if (CHANNEL_HANDLED_TOOLS.has(request.params.name)) {
      return {
        isError: true,
        content: [{ type: 'text', text: `${request.params.name} is handled by the channel itself; there is nothing to call.` }],
      }
    }
    try {
      const result = await withMcpClient(serverUrl, await getToken(), (client) => client.callTool(request.params))
      if (TRACKED_TASK_TOOLS.has(request.params.name)) {
        activity.observeTaskToolCall(request.params.name, request.params.arguments, result)
      }
      return result
    } catch (error) {
      // A tool result the model can read and react to, rather than a
      // protocol error it can't see the cause of.
      log(`[${identity.agentName}] tool call ${request.params.name} failed: ${String(error)}`)
      return { isError: true, content: [{ type: 'text', text: `Couldn't reach Holodeck: ${String(error)}` }] }
    }
  })

  // Claude Code drops these silently when the session didn't load this server
  // as a channel, and doesn't acknowledge them either way - so a failure here
  // can only mean the transport is gone.
  async function push({ content, meta }: ChannelNotification): Promise<void> {
    try {
      await mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })
    } catch (error) {
      log(`[${identity.agentName}] couldn't push an event into the session: ${String(error)}`)
    }
  }
  const pushEvent = (event: ChannelEvent) => void push(describeChannelEvent(event))

  // Connected before the push connection starts: an event arriving while the
  // transport isn't up yet would have nowhere to go.
  await mcp.connect(new StdioServerTransport())

  let droppedAt: number | undefined
  const connection = startPersonaConnection({ name: identity.agentName, token: getToken }, serverUrl, {
    log,
    // The first connect always reconciles; a reconnect only after a real
    // outage (channelEvents.ts's RECONCILE_AFTER_GAP_MS): a drop-and-retry of
    // a second or two would otherwise cost a turn of the model each time for
    // nothing (seen live: an idle session reconnected on its own and the
    // Agent spent a turn re-checking a Task list that hadn't changed).
    onDisconnected: () => {
      droppedAt = Date.now()
    },
    onConnected: () => {
      if (shouldReconcileOnConnect(droppedAt, Date.now())) {
        void push(describeChannelConnected(identity.agentName))
      }
      droppedAt = undefined
    },
    onSubscriptionMatched: pushEvent,
    onAgentInstructionSent: pushEvent,
    onScheduledCheckDue: pushEvent,
    onAgentInstructionsUpdated: pushEvent,
    onAgentAddedToProject: pushEvent,
    onAgentRemovedFromProject: pushEvent,
    onAgentMentioned: pushEvent,
    // The owner's "Stop" in the Web UI: tell the session, then go offline
    // (stop() also reports the disconnect, so the Web UI's dot flips). The
    // process stays up but idle - exiting would make Claude Code show the
    // server as failed and offer to restart it, the opposite of "stopped".
    onAgentStopRequested: () => {
      void push(describeChannelStopped('stop_requested')).then(() => connection.stop())
    },
    // A newer session took this Agent over: the connection already stopped
    // itself (see agentConnection.ts); just say so.
    onConnectionReplaced: () => {
      replaced = true
      void push(describeChannelStopped('replaced'))
      // Claude Code re-reads the tool list on this, so the tools disappear
      // from the session instead of only failing when called.
      void mcp.sendToolListChanged().catch(() => {})
    },
  })

  // Claude Code ending the session closes this process's stdin. The SDK's
  // stdio transport only listens for data on it, not for the end, so it is
  // watched here directly (found by the end-to-end check: without this the
  // disconnect was never reported and the process waited to be killed); a
  // signal covers the rest. Report the disconnect on the way out so the Web
  // UI flips offline right away instead of after the 5 minute heartbeat
  // window.
  let shuttingDown = false
  async function shutDown(): Promise<void> {
    if (shuttingDown) {
      return
    }
    shuttingDown = true
    activity.stop()
    await connection.stop()
    process.exit(0)
  }
  mcp.onclose = () => void shutDown()
  process.stdin.once('end', () => void shutDown())
  process.stdin.once('close', () => void shutDown())
  process.once('SIGINT', () => void shutDown())
  process.once('SIGTERM', () => void shutDown())

  log(`[${identity.agentName}] channel ready`)
}
