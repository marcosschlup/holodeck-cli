import fs from 'node:fs'
import {
  startPersonaConnection,
  type AgentAddedToProjectEvent,
  type PersonaConnection,
  type ScheduledCheckDueEvent,
  type SubscriptionMatchedEvent,
} from './agentConnection.js'
import { startPersonaSession, type PersonaSession } from './agentSession.js'
import { loadServerUrl } from './config.js'
import { createIpcServer, listenIpcServer, pidFilePath, type IpcRequest, type IpcResponse } from './ipc.js'
import { dataDir } from './paths.js'
import { appendLog, deleteLog } from './personaLog.js'
import { loadPersonas, removePersona, upsertPersona, type PersonaRecord } from './store.js'

function statusFor(record: PersonaRecord, connection: PersonaConnection | undefined): string {
  return record.paused ? 'paused' : (connection?.getStatus() ?? 'connecting')
}

// In-memory mirror of the persisted store (src/store.ts) — loaded once at
// startup below, kept in sync on every register/unregister so `status`
// never has to go back to disk on every request.
const personas = new Map<string, PersonaRecord>()

// Each registered persona's own held-open /agent/events connection
// (HOL-55) — a separate map, not folded into `personas` above, since a
// connection is live runtime state (a fetch stream, a reconnect loop)
// that has no business being persisted, unlike the record itself.
const connections = new Map<string, PersonaConnection>()

// Each registered persona's own live Claude Agent SDK session (HOL-57) —
// a third map alongside `connections`, deliberately separate from it:
// the /agent/events connection and the persona's actual Claude session
// are two different lifetimes (a connection can drop and reconnect
// without losing the session's own conversation state).
const sessions = new Map<string, PersonaSession>()

// Resolved once when the daemon starts (config.ts's own file, HOL-54's
// `holodeck config set-server`) — every persona on this one daemon talks
// to the same Holodeck server; changing it takes effect on the next
// daemon start, not live.
let serverUrl = ''

// Last time this persona's session was sent the *generic* "go check
// everything" nudge — RECONCILE_PROMPT, sent from both `startSession`
// (session start) and `startConnection`'s `onConnected` (every connect or
// reconnect). Both call sites share the one prompt on purpose now (HOL-68,
// 2026-09-04) — they used to be two different, narrower prompts
// (CHECK_IN_PROMPT only checked assigned Tasks; RECONCILE_PROMPT only
// checked subscriptions/schedules/instructions), and this same dedup window
// existed to stop the near-duplicate double-send when `startConnection` and
// `startSession` run back-to-back for a brand-new session (register/
// unpause/restart/daemon-reload) — but a restart only ever sent
// CHECK_IN_PROMPT (from `startSession`, synchronous) because `onConnected`
// fires moments later, after the network round trip, and by then this
// window suppressed it as "recently nudged." Found live: Marcos restarted
// Agent Connector to pick up HOL-67's `list_my_instructions` reconcile fix,
// and the persona never checked instructions at all — CHECK_IN_PROMPT (the
// one that actually ran) never mentioned instructions, subscriptions, or
// schedules in the first place. One shared prompt for both moments removes
// the whole "which of the two actually fires" question. Deliberately does
// NOT gate `onSubscriptionMatched`
// below: a live push names a specific subscription/Task, a distinct,
// genuine occurrence each Agent Connector actually cares about — coalescing
// it into this same window would silently drop real-time reactivity, the
// one thing HOL-61 exists to add. Not a fully engineered de-dup (HOL-61's
// own scope note) — just enough to stop the one obviously redundant case.
const lastGenericNudgeAt = new Map<string, number>()
const NUDGE_DEDUP_WINDOW_MS = 15_000

function recentlyNudgedGenerically(name: string): boolean {
  return Date.now() - (lastGenericNudgeAt.get(name) ?? 0) < NUDGE_DEDUP_WINDOW_MS
}

function nudge(name: string, text: string): void {
  sessions.get(name)?.send(text)
}

function genericNudge(name: string, text: string): void {
  lastGenericNudgeAt.set(name, Date.now())
  nudge(name, text)
}

// HOL-61 "case 2" — every connect or reconnect (first time ever, or after
// being offline, no distinction) is Agent Connector's cue to have the
// persona reconcile: check everything that might currently need its
// attention and react to what does. Deliberately a text nudge, not
// TypeScript code that evaluates patterns/schedules/instructions itself —
// the persona already has the MCP tools (list_tasks, list_my_subscriptions,
// list_my_schedules, list_my_instructions, get_task, ...) and the judgement
// to decide what "needs attention" means per case; duplicating that
// reasoning in this codebase would mean maintaining a second, parallel
// decision-maker just to decide what to tell the first one, for no benefit
// (same "reconcile, don't replay" posture PLAN.md already settled on,
// extended to who does the reconciling).
//
// One prompt, covering the three things a fresh connection or a reconnect
// after being offline might have missed — Mechanism 1 subscriptions,
// Mechanism 2 scheduled checks, and Mechanism 3 direct instructions. Used
// identically at session start (startSession) and at every connect/
// reconnect (startConnection's onConnected) — see lastGenericNudgeAt's own
// comment above for why this used to be two separate, narrower prompts and
// why that was a real bug (HOL-68, 2026-09-04): whichever of the two
// actually fired on a given restart might not be the one that mentions the
// thing that just changed.
//
// Deliberately does NOT also say "list_tasks with assignedToMe" as its own
// separate step (HOL-57's original MVP trigger, still here through HOL-68's
// merge) — found live (2026-09-04, Marcos): that unconditional line has no
// status awareness of its own, so it kept surfacing Tasks already `done`
// for the persona to re-check even after HOL-69/HOL-70 taught the
// "Assigned to me" subscription's own pattern/description to exclude
// exactly that. Two lines meaning almost the same thing, one of them
// ignorant of the filtering the other just learned, is the same class of
// bug HOL-68 already fixed once (two prompts silently diverging) — not
// something to reintroduce as two clauses in the same prompt.
//
// HOL-73 (2026-09-04): even with that line gone, reconciling the three
// starter-pack Task-level subscriptions ("Assigned to me," "Interaction
// added on my task," "Blocked response on my task") the same way as any
// other subscription — "check current state via list_tasks/get_task" —
// still meant enumerating every Task ever assigned to the persona and
// fetching each one's full detail, scaling with a Project's total history,
// not with what's actually new. `list_recent_activity_on_my_tasks` (new
// MCP tool, backend) replaces that: one query, keyed off this Agent's own
// read cursor, that only ever returns what changed since last checked.
// It's called out explicitly for those three subscriptions, separate from
// the general "list_my_subscriptions, check current state" clause that
// still applies as-is to any other (arbitrary-pattern) subscription — a
// single cursor query keyed on "my currently-assigned Tasks" doesn't
// generalize to a subscription about arbitrary Project content, so custom
// subscriptions still get the old per-subscription treatment.
//
// The closing sentence is a guard-rail, not a report to anyone (found live,
// 2026-09-04, Marcos: this final text has no live reader — Agent Connector
// only writes it to personaLog for a human to read later, if they ever do —
// so phrasing it as "say so" implied an audience that doesn't exist). What
// actually matters is "stop": without an explicit instruction not to, a
// model asked to "check everything" on every single reconnect can drift
// toward inventing a reason to act, just to look useful for that pass, even
// when reconciling genuinely turned up nothing. That's the failure mode
// this line exists to prevent — worth keeping, reworded around that instead
// of around producing a summary for someone.
const RECONCILE_PROMPT =
  "You just connected to Holodeck. Check everything that might need your attention: call list_recent_activity_on_my_tasks for anything new on your currently-assigned Tasks (covers your Assigned-to-me/Interaction/Blocked-response subscriptions in one call — prefer it over list_tasks/get_task for that); list_my_subscriptions and check current state for any other subscription not already covered by that (list_tasks/get_task/get_project_context as appropriate); list_my_schedules for your own standing scheduled checks (informational — the scheduler fires these on its own, only relevant here if something looks wrong); and list_my_instructions for any direct instruction sent while you were offline. React to anything that needs it — don't invent work where there isn't any. If nothing needs attention, just stop; no summary needed."

// HOL-61 "case 1" — a live subscription_matched push arrived on the
// already-open connection. The push itself is deliberately minimal (PLAN.md
// Mechanism 1: no summary/metadata, "go call get_task and figure out what
// to do") — this just names which subscription fired and where, the
// persona does the actual reacting.
function subscriptionMatchedPrompt(event: SubscriptionMatchedEvent): string {
  const taskPart = event.taskId ? ` (task id ${event.taskId})` : ''
  return `Your event subscription "${event.data.subscriptionName}" just matched, in project ${event.projectId}${taskPart}. Check current state (get_task/list_tasks) and react appropriately.`
}

// HOL-65 (Mechanism 3) — a direct instruction just arrived. Deliberately
// doesn't repeat the instruction's own text here (that would let this nudge
// and list_my_instructions's own read drift out of sync, and skip the
// "reading it is what marks it seen" step PLAN.md specifies) — just tells
// the persona to go read it the same way it would find one after a
// reconnect (RECONCILE_PROMPT above).
const AGENT_INSTRUCTION_SENT_PROMPT =
  'A new direct instruction just arrived. Call list_my_instructions to read and act on it.'

// HOL-60 (Mechanism 2) — unlike the two prompts above, `instruction` has to
// travel in this nudge itself: the push already carries it (PLAN.md: "the
// push has to carry the instruction itself," since a scheduled check has no
// other state to re-derive "what am I supposed to do" from), so repeating
// it here is the point, not a shortcut.
function scheduledCheckDuePrompt(event: ScheduledCheckDueEvent): string {
  const taskPart = event.taskId ? ` (task id ${event.taskId})` : ''
  return `Your scheduled check "${event.data.name}" just fired, in project ${event.projectId}${taskPart}. Instruction: ${event.data.instruction}`
}

// PLAN.md "Mechanism 1... Reserved event types" — the three reactions it
// specifies for an Agent's own configuration changing, not Project content.
const AGENT_INSTRUCTIONS_UPDATED_PROMPT =
  'Your instructions were just updated — review them and adjust your event subscriptions if it makes sense (list_my_subscriptions/subscribe_to_event/unsubscribe_from_event).'

function agentAddedToProjectPrompt(event: AgentAddedToProjectEvent): string {
  return `You were just added to project ${event.projectId}. Consider whether it needs its own event subscriptions or scheduled checks (subscribe_to_event, schedule_check).`
}

const AGENT_REMOVED_FROM_PROJECT_PROMPT =
  "You were just removed from a project — its event subscriptions are already cleaned up server-side, nothing to do there. Just noting it in case it's relevant to anything else you're doing."

// Shared by the local `pause` IPC op and the remote `agent_stop_requested`
// push (HOL-77, Web UI "Stop") — both mean the exact same thing, "stop this
// persona now, mark it paused." Fire-and-forget on `connection.stop()`/
// `session.close()` (not awaited), same as `pause` already did before this
// was extracted: `connection.stop()` itself awaits this same connection's
// own read loop, and `agent_stop_requested` fires *from inside* that read
// loop's own frame handling — awaiting it here would deadlock the loop on
// itself. The persisted/in-memory `paused` state is already correct by the
// time this function returns either way, which is all `list`/`status`
// need; the disconnect signal (`report_disconnect`, inside `stop()`)
// reaching Holodeck a moment later is fine (same reasoning as
// recordAgentHeartbeat's own fire-and-forget write, backend mcp/auth.ts).
function stopPersona(name: string): void {
  const record = personas.get(name)
  if (record) {
    const paused: PersonaRecord = { ...record, paused: true }
    personas.set(paused.name, paused)
    upsertPersona(paused)
  }
  const connection = connections.get(name)
  connections.delete(name)
  connection?.stop().catch(() => {})
  const session = sessions.get(name)
  sessions.delete(name)
  session?.close().catch(() => {})
}

function startConnection(record: PersonaRecord): void {
  connections.get(record.name)?.stop().catch(() => {})
  connections.set(
    record.name,
    startPersonaConnection(record, serverUrl, {
      onConnected: () => {
        if (recentlyNudgedGenerically(record.name)) {
          return
        }
        genericNudge(record.name, RECONCILE_PROMPT)
      },
      onSubscriptionMatched: (event) => {
        nudge(record.name, subscriptionMatchedPrompt(event))
      },
      onAgentInstructionSent: () => {
        nudge(record.name, AGENT_INSTRUCTION_SENT_PROMPT)
      },
      onScheduledCheckDue: (event) => {
        nudge(record.name, scheduledCheckDuePrompt(event))
      },
      onAgentInstructionsUpdated: () => {
        nudge(record.name, AGENT_INSTRUCTIONS_UPDATED_PROMPT)
      },
      onAgentAddedToProject: (event) => {
        nudge(record.name, agentAddedToProjectPrompt(event))
      },
      onAgentRemovedFromProject: () => {
        nudge(record.name, AGENT_REMOVED_FROM_PROJECT_PROMPT)
      },
      onAgentStopRequested: () => {
        stopPersona(record.name)
      },
    }),
  )
}

// MVP trigger (HOL-57's own scope note: "the simplest defensible MVP
// trigger... rather than blocking on HOL-46 being done first") — a
// persona's session gets one real turn the moment it (re)connects. The
// other trigger is an explicit `holodeck restart <persona>`, handled by the
// 'restart' IPC op below reusing this same function. Sends RECONCILE_PROMPT
// (was its own narrower CHECK_IN_PROMPT — merged, HOL-68, see
// lastGenericNudgeAt's own comment above for why keeping them separate was
// a real bug, not just duplication).
function startSession(record: PersonaRecord): void {
  sessions.get(record.name)?.close().catch(() => {})
  const session = startPersonaSession(record)
  session.onMessage((message) => appendLog(record.name, message))
  sessions.set(record.name, session)
  genericNudge(record.name, RECONCILE_PROMPT)
}

async function handleRequest(request: IpcRequest, startedAt: number, shutdown: () => Promise<void>): Promise<IpcResponse> {
  switch (request.op) {
    case 'status':
      return { op: 'status', ok: true, pid: process.pid, personaCount: personas.size, uptimeMs: Date.now() - startedAt }
    case 'register': {
      // Registering (including re-registering an already-known name)
      // always means "I want this active" — clears any previous `paused`
      // from a `stop` rather than leaving a freshly (re-)registered
      // persona sitting paused for no visible reason.
      const record: PersonaRecord = { name: request.name, token: request.token, cwd: request.cwd, model: request.model }
      personas.set(record.name, record)
      upsertPersona(record)
      startConnection(record)
      startSession(record)
      return { op: 'register', ok: true }
    }
    case 'pause': {
      if (!personas.get(request.name)) {
        return { op: 'pause', ok: true, found: false }
      }
      stopPersona(request.name)
      return { op: 'pause', ok: true, found: true }
    }
    case 'unpause': {
      const record = personas.get(request.name)
      if (!record) {
        return { op: 'unpause', ok: true, found: false }
      }
      const resumed: PersonaRecord = { ...record, paused: false }
      personas.set(resumed.name, resumed)
      upsertPersona(resumed)
      startConnection(resumed)
      startSession(resumed)
      return { op: 'unpause', ok: true, found: true }
    }
    case 'restart': {
      const record = personas.get(request.name)
      if (!record) {
        return { op: 'restart', ok: true, found: false }
      }
      startSession(record)
      return { op: 'restart', ok: true, found: true }
    }
    case 'forget': {
      const removed = personas.delete(request.name)
      removePersona(request.name)
      // Same not-awaited reasoning as 'pause' above.
      const connection = connections.get(request.name)
      connections.delete(request.name)
      connection?.stop().catch(() => {})
      const session = sessions.get(request.name)
      sessions.delete(request.name)
      session?.close().catch(() => {})
      deleteLog(request.name)
      return { op: 'forget', ok: true, removed }
    }
    case 'list':
      return {
        op: 'list',
        ok: true,
        personas: [...personas.values()].map((p) => ({
          name: p.name,
          cwd: p.cwd,
          status: statusFor(p, connections.get(p.name)),
        })),
      }
    case 'shutdown':
      // Responds first, then shuts this process down on the next tick —
      // the caller needs to actually see the "ok" before the socket goes
      // away, not race the exit against its own response being flushed.
      setImmediate(() => void shutdown())
      return { op: 'shutdown', ok: true }
  }
}

// The daemon process itself — one per machine (PLAN.md 9), started either
// directly (`holodeck start --foreground`) or as a detached child spawned
// by `holodeck start` (cli.ts). Resolves once the IPC server is up and
// accepting connections; the process itself keeps running after that
// (the listening socket holds the event loop open) until killed or a
// SIGINT/SIGTERM triggers the shutdown handler below.
export async function runDaemon(): Promise<void> {
  const startedAt = Date.now()

  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(pidFilePath(), String(process.pid))

  serverUrl = loadServerUrl()

  // Reload every previously-registered persona (HOL-53) — the whole point
  // of persisting them is that a crash/reboot doesn't force re-running
  // `register` for each one by hand. Each active one gets its own
  // /agent/events connection right away (HOL-55), same as a
  // freshly-registered persona — a paused one (`holodeck stop <persona>`)
  // deliberately does NOT auto-reconnect here, or `stop` wouldn't really
  // mean "leave this alone until I say otherwise."
  for (const record of loadPersonas()) {
    personas.set(record.name, record)
    if (!record.paused) {
      startConnection(record)
      startSession(record)
    }
  }

  // Deliberate shutdown (SIGINT/SIGTERM, or `holodeck stop --all`'s
  // `shutdown` IPC op) — tells Holodeck every persona's connection is
  // closing on purpose (report_disconnect, PLAN.md 9) before actually
  // closing them, so each Agent flips offline immediately instead of
  // waiting out the heartbeat's grace window. A killed/crashed process
  // never reaches this, which is exactly when that grace window is
  // supposed to matter.
  const shutdown = async () => {
    await Promise.all([...connections.values()].map((connection) => connection.stop()))
    await Promise.all([...sessions.values()].map((session) => session.close()))
    server.close(() => process.exit(0))
  }
  const server = createIpcServer((request) => handleRequest(request, startedAt, shutdown))
  await listenIpcServer(server)

  // Tells whoever spawned this process (cli.ts's `ensureDaemonRunning`)
  // that the IPC server is actually up, the instant it's true — real
  // signaling over the parent/child IPC channel `spawn()` was given
  // (`stdio: [..., 'ipc']`), not the caller guessing how long "probably
  // started by now" is. `process.send` only exists when that channel is
  // there in the first place (a detached background start): running via
  // `--foreground` directly, or a --__daemon invocation whose parent
  // didn't request one, has nothing listening for this and the optional
  // call is simply a no-op.
  process.send?.('ready')

  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  // No explicit "keep running" wait needed below this — a listening
  // net.Server already keeps Node's event loop alive on its own, the same
  // reason a plain http.createServer().listen() app doesn't exit either.
}
