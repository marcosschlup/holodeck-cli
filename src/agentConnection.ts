import { CONNECTOR_USER_AGENT, reportDisconnect, reportHealth } from './holodeck.js'

// Who the connection acts as. `token` is a plain string for a daemon persona
// (`PersonaRecord`'s static token), or a function for a Channel (HOL-130),
// whose Agent-scoped token expires hourly and is fetched fresh each time it's
// needed (holodeckApi.ts's getAgentAccessToken keeps it cached and renewed).
export interface ConnectionIdentity {
  name: string
  token: string | (() => Promise<string>)
}

function resolveToken(identity: ConnectionIdentity): Promise<string> {
  return Promise.resolve(typeof identity.token === 'string' ? identity.token : identity.token())
}

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting'

export interface PersonaConnection {
  getStatus: () => ConnectionStatus
  // Signals the connection loop not to reconnect, tells Holodeck this
  // disconnect is deliberate (report_disconnect), and waits for the loop
  // to actually finish. Safe to call more than once.
  stop: () => Promise<void>
}

// Mirrors backend/src/lib/projectEvents.ts's `subscription_matched` push
// shape (PLAN.md Mechanism 1) — deliberately minimal, no `summary`, "go
// call get_task and figure out what to do" rather than a human-authored
// sentence to read. `taskId` is the Task's internal id, not its display
// id (e.g. "TES-3") — a persona reacting to this needs get_task, which
// accepts either.
export interface SubscriptionMatchedEvent {
  type: 'subscription_matched'
  projectId: string
  taskId?: string
  data: { subscriptionId: string; subscriptionName: string }
}

// Mirrors backend/src/trpc/routers/agent.ts's `sendInstruction` push
// (PLAN.md "Mechanism 3 — direct instruction") — deliberately minimal, same
// "go look" shape as SubscriptionMatchedEvent: it just says one is pending,
// the persona calls list_my_instructions to actually read it (and mark it
// seen — reading it IS the read-tracking mechanism, not this push arriving).
export interface AgentInstructionSentEvent {
  type: 'agent_instruction_sent'
  data: { instructionId: string }
}

// Mirrors backend/src/domains/agentScheduledCheck/service.ts's
// executeAndAdvanceScheduledCheck push (PLAN.md "Mechanism 2 — scheduled
// checks") — unlike the two events above, this one is NOT minimal: `instruction`
// travels in the payload itself, since there's no other state to re-derive
// "what am I supposed to do" from (PLAN.md's own wording).
export interface ScheduledCheckDueEvent {
  type: 'scheduled_check_due'
  projectId: string
  taskId?: string
  data: { checkId: string; name: string; instruction: string; queryResult?: { taskIds: string[] } }
}

// The three reserved events PLAN.md's "Mechanism 1... Reserved event types"
// section designed (an Agent's own configuration changing, not Project
// content) — found live (2026-09-04) they had the exact same silent-drop
// gap as the two above: the backend has pushed these since before Mechanism
// 2/3 existed, but nothing here ever recognized them.
export interface AgentInstructionsUpdatedEvent {
  type: 'agent_instructions_updated'
}
export interface AgentAddedToProjectEvent {
  type: 'agent_added_to_project'
  projectId: string
}
export interface AgentRemovedFromProjectEvent {
  type: 'agent_removed_from_project'
  projectId: string
}

// PLAN.md "Web UI: remote Stop" (HOL-77) — the owner clicked "Stop" in the
// Web UI. Same shape as the other minimal pushes: no payload beyond the
// type itself, this connection already knows which persona it is.
export interface AgentStopRequestedEvent {
  type: 'agent_stop_requested'
}

export interface PersonaConnectionHandlers {
  // Where this connection's own status lines go (connected, dropped, ...).
  // Defaults to stdout - which a Channel can't use: its stdout IS the MCP
  // stdio transport to Claude Code, so anything else written there corrupts
  // the protocol (HOL-130).
  log?: (message: string) => void
  // Fired when Holodeck closes this connection because a newer one for the
  // same Agent took over (`connection_replaced`). When a handler is given,
  // the connection does NOT reconnect: two live sessions for one Agent
  // would otherwise steal the connection back and forth forever, each
  // eviction evicting the other. Without a handler the original behavior
  // stays: reconnect after the backoff.
  onConnectionReplaced?: () => void
  // Fired every time the connection reaches 'connected' — the very first
  // connect and every reconnect after a drop, no distinction (HOL-61:
  // "reconcile, don't replay" — this is the hook for a persona to catch up
  // on anything it missed while offline).
  onConnected?: () => void
  // Fired for every `subscription_matched` frame received while the
  // connection is live (HOL-61's "case 1" — a genuine real-time push).
  onSubscriptionMatched?: (event: SubscriptionMatchedEvent) => void
  // Fired for every `agent_instruction_sent` frame (Mechanism 3, HOL-65) —
  // found live (2026-09-04, Marcos) that this and scheduled_check_due below
  // were pushed by the server but never wired to anything here, so a sent
  // instruction/a due schedule silently did nothing.
  onAgentInstructionSent?: (event: AgentInstructionSentEvent) => void
  // Fired for every `scheduled_check_due` frame (Mechanism 2, HOL-60).
  onScheduledCheckDue?: (event: ScheduledCheckDueEvent) => void
  // Fired when the owner edits this Agent's persona/instructions.
  onAgentInstructionsUpdated?: (event: AgentInstructionsUpdatedEvent) => void
  // Fired when this Agent is registered into a new Project.
  onAgentAddedToProject?: (event: AgentAddedToProjectEvent) => void
  // Fired when this Agent is removed from a Project.
  onAgentRemovedFromProject?: (event: AgentRemovedFromProjectEvent) => void
  // Fired when the owner clicks "Stop" in the Web UI (HOL-77) — the
  // handler is expected to actually stop the persona (close the session,
  // this connection, and report the disconnect), same as a local
  // `holodeck stop <persona>` does.
  onAgentStopRequested?: (event: AgentStopRequestedEvent) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Capped exponential backoff for reconnect attempts (network blip, an
// eviction by a second connection elsewhere) — PLAN.md 9/HOL-55: "don't
// just die." 1s, 2s, 4s, ... up to 30s, not unbounded.
function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt)
}

// One persona's held-open /agent/events connection, reconnecting on drop
// until `stop()` is called. `fetch`'s streaming body (not a browser
// `EventSource`, which can't set the Bearer header this endpoint needs —
// PLAN.md 9's own note on why) is manually parsed as SSE frames: `GET
// /agent/events` (backend/src/app.ts) writes plain `data: <json>\n\n`
// frames, nothing more elaborate (no `event:`/`id:` lines) to parse.
export function startPersonaConnection(
  record: ConnectionIdentity,
  serverUrl: string,
  handlers?: PersonaConnectionHandlers,
): PersonaConnection {
  let status: ConnectionStatus = 'connecting'
  let stopped = false
  let abortController: AbortController | null = null

  function log(message: string): void {
    const line = `[${record.name}] ${message}`
    if (handlers?.log) {
      handlers.log(line)
    } else {
      console.log(line)
    }
  }

  async function handleFrame(frame: string): Promise<void> {
    const dataLine = frame.split('\n').find((line) => line.startsWith('data:'))
    if (!dataLine) {
      return
    }
    const event = JSON.parse(dataLine.slice('data:'.length).trim()) as
      | SubscriptionMatchedEvent
      | AgentInstructionSentEvent
      | ScheduledCheckDueEvent
      | AgentInstructionsUpdatedEvent
      | AgentAddedToProjectEvent
      | AgentRemovedFromProjectEvent
      | AgentStopRequestedEvent
      | { type: string }
    if (event.type === 'health_check') {
      try {
        const report = await reportHealth(serverUrl, await resolveToken(record))
        log(`answered health_check (uptime ${report.uptimeMs ?? '?'}ms)`)
      } catch (error) {
        log(`failed to answer health_check: ${String(error)}`)
      }
    } else if (event.type === 'subscription_matched') {
      const matched = event as SubscriptionMatchedEvent
      log(`subscription matched: "${matched.data.subscriptionName}"`)
      handlers?.onSubscriptionMatched?.(matched)
    } else if (event.type === 'agent_instruction_sent') {
      const sent = event as AgentInstructionSentEvent
      log(`instruction sent (${sent.data.instructionId})`)
      handlers?.onAgentInstructionSent?.(sent)
    } else if (event.type === 'scheduled_check_due') {
      const due = event as ScheduledCheckDueEvent
      log(`scheduled check due: "${due.data.name}"`)
      handlers?.onScheduledCheckDue?.(due)
    } else if (event.type === 'agent_instructions_updated') {
      log('instructions updated')
      handlers?.onAgentInstructionsUpdated?.(event as AgentInstructionsUpdatedEvent)
    } else if (event.type === 'agent_added_to_project') {
      const added = event as AgentAddedToProjectEvent
      log(`added to project ${added.projectId}`)
      handlers?.onAgentAddedToProject?.(added)
    } else if (event.type === 'agent_removed_from_project') {
      const removed = event as AgentRemovedFromProjectEvent
      log(`removed from project ${removed.projectId}`)
      handlers?.onAgentRemovedFromProject?.(removed)
    } else if (event.type === 'agent_stop_requested') {
      log('stop requested from Web UI')
      handlers?.onAgentStopRequested?.(event as AgentStopRequestedEvent)
    } else if (event.type === 'connection_replaced' && handlers?.onConnectionReplaced) {
      log('replaced by a newer connection for this Agent')
      // Set before the handler so the loop below can't reconnect in the
      // meantime, and so stop() skips report_disconnect: the newer
      // connection is the live one, reporting a disconnect would flip the
      // Agent offline underneath it.
      stopped = true
      handlers.onConnectionReplaced()
    }
    // Otherwise 'connection_replaced' needs no handling here beyond letting
    // the stream end naturally (the server closes it right after sending
    // this) — the read loop below's own `done` branch takes it from there.
  }

  async function consumeStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        return
      }
      buffer += decoder.decode(value, { stream: true })
      let separatorIndex = buffer.indexOf('\n\n')
      while (separatorIndex !== -1) {
        const frame = buffer.slice(0, separatorIndex)
        buffer = buffer.slice(separatorIndex + 2)
        await handleFrame(frame)
        separatorIndex = buffer.indexOf('\n\n')
      }
    }
  }

  async function runLoop(): Promise<void> {
    let attempt = 0
    while (!stopped) {
      status = attempt === 0 ? 'connecting' : 'reconnecting'
      abortController = new AbortController()
      try {
        const response = await fetch(new URL('/agent/events', serverUrl), {
          headers: {
            Authorization: `Bearer ${await resolveToken(record)}`,
            'User-Agent': CONNECTOR_USER_AGENT,
            Accept: 'text/event-stream',
          },
          signal: abortController.signal,
        })
        if (!response.ok || !response.body) {
          throw new Error(`unexpected /agent/events response: ${response.status}`)
        }
        status = 'connected'
        attempt = 0
        log('connected')
        handlers?.onConnected?.()
        await consumeStream(response.body)
        if (!stopped) {
          log('connection closed by server')
        }
      } catch (error) {
        if (stopped) {
          return
        }
        log(`connection error: ${String(error)}`)
      }
      if (stopped) {
        return
      }
      const delayMs = backoffMs(attempt)
      attempt += 1
      await sleep(delayMs)
    }
  }

  const loopPromise = runLoop()

  return {
    getStatus: () => status,
    async stop() {
      if (stopped) {
        return
      }
      stopped = true
      abortController?.abort()
      try {
        await reportDisconnect(serverUrl, await resolveToken(record))
      } catch (error) {
        log(`failed to report disconnect: ${String(error)}`)
      }
      await loopPromise.catch(() => {})
    },
  }
}
