import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { startPersonaConnection } from './agentConnection.js'
import { describeChannelEvent, describeChannelStopped, type ChannelEvent, type ChannelNotification } from './channelEvents.js'
import { resolveAgentIdentity } from './holodeck.js'
import { getAgentAccessToken, NotLoggedInError } from './holodeckApi.js'
import { loadLoginCredential } from './loginCredential.js'

// `holodeck channel run <agentId>` (HOL-130): a Claude Code Channel - an MCP
// server Claude Code itself spawns over stdio (from the `.mcp.json` entry
// `channel add` wrote) and that pushes Holodeck's events into the running
// session as `<channel>` tags, so a Task assigned to the Agent reaches it
// live instead of being polled for. One-way: no tools capability, nothing
// the model writes goes back through here.
//
// stdout belongs to the MCP transport, so NOTHING else may write to it -
// every status line goes to stderr (where Claude Code's `--debug` log picks
// it up). One process per Claude Code session: there is no daemon to talk
// to, and two sessions never share a Channel process.

function log(message: string): void {
  process.stderr.write(`${message}\n`)
}

function buildInstructions(agentName: string): string {
  return [
    `You are connected to Holodeck as the Agent "${agentName}". Holodeck pushes events to you as <channel ... event="..."> tags: a subscription of yours matched a Task, your owner sent you a direct instruction, a scheduled check of yours is due, or your own setup changed (instructions edited, added to or removed from a project).`,
    'They are one-way: nothing you write back reaches Holodeck through this channel. To act on an event, use Holodeck\'s own MCP tools for this same Agent when they are available in this session (get_task, add_interaction, set_resolution, ...); each event body names the tool to reach for. If those tools are not available, tell the user what happened instead of guessing.',
  ].join('\n\n')
}

export async function runChannel(agentId: string, version: string): Promise<void> {
  const login = loadLoginCredential()
  if (!login) {
    throw new NotLoggedInError()
  }
  const { serverUrl } = login
  const getToken = async () => (await getAgentAccessToken(agentId, 'channel')).accessToken

  // Before anything is served: proves the Agent can run as a Channel right now
  // (exists, right type, still owned) and gives its name for the instructions.
  // A failure here exits non-zero, which Claude Code shows as this server
  // being `failed` in `/mcp`.
  const identity = await resolveAgentIdentity(serverUrl, await getToken())

  const mcp = new Server(
    { name: 'holodeck-channel', version },
    // The `claude/channel` key is what makes this a channel. No `tools`:
    // one-way.
    { capabilities: { experimental: { 'claude/channel': {} } }, instructions: buildInstructions(identity.agentName) },
  )

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

  const connection = startPersonaConnection({ name: identity.agentName, token: getToken }, serverUrl, {
    log,
    onSubscriptionMatched: pushEvent,
    onAgentInstructionSent: pushEvent,
    onScheduledCheckDue: pushEvent,
    onAgentInstructionsUpdated: pushEvent,
    onAgentAddedToProject: pushEvent,
    onAgentRemovedFromProject: pushEvent,
    // The owner's "Stop" in the Web UI: tell the session, then go offline
    // (stop() also reports the disconnect, so the Web UI's dot flips). The
    // process stays up but idle - exiting would make Claude Code show the
    // server as failed and offer to restart it, the opposite of "stopped".
    onAgentStopRequested: () => {
      void push(describeChannelStopped('stop_requested')).then(() => connection.stop())
    },
    // A newer session took this Agent over: the connection already stopped
    // itself (see agentConnection.ts); just say so.
    onConnectionReplaced: () => void push(describeChannelStopped('replaced')),
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
