import type { LiveActivityEvent, LiveActivityKind, LiveActivityOutcome, TaskRef } from './liveActivityEvents.js'
import { toTaskRef } from './liveActivityEvents.js'

// Turns a `holodeck agent start` session's Claude Code hooks into V2 live
// activity events (docs/agent-live-activity-v2.md, sections 4, 6 and 8.4, and
// the measured hook behavior in 3.1). The hooks only ever template ids and
// timings (agentCommands.ts builds them), so no tool input or output reaches
// this process.
//
// What this tracks, per session:
// - Lines: `main`, plus one per subagent (`agent_id`). Background subagents
//   outlive the turn that spawned them.
// - Runs: a main-line turn (`${session}:${prompt}`), or a subagent's whole life
//   (`${session}:${agent}`). A subagent's own `prompt_id` is the session's
//   current turn and can change mid tool call, so it's never used for its run.
// - Each line's context: the last Holodeck Task one of its tool calls named.
// - Tool calls in flight, so a denied or interrupted one can be closed: the
//   hooks report nothing for those, not even a `Stop`.

// The hook kinds agentCommands.ts sends, one per Claude Code hook event.
export type HookKind =
  | 'turn_started'
  | 'tool_started'
  | 'tool_awaiting_permission'
  | 'tool_succeeded'
  | 'tool_failed'
  | 'subagent_started'
  | 'subagent_stopped'
  | 'turn_stopped'
  | 'turn_failed'
  | 'session_ended'

export interface ChannelActivityReporter {
  // The hidden hook tool's handler. Never throws and never waits on the network.
  handleHookCall(args: Record<string, unknown>): { content: { type: 'text'; text: string }[] }
  // Called by the channel proxy after a forwarded `create_task` returns: its
  // result is the only place the new Task's id exists. Linked to the hook
  // stream by the tool call id Claude Code sends in the request's `_meta`.
  observeCreatedTask(toolUseId: string | undefined, result: unknown): void
}

interface ReporterOptions {
  send: (event: LiveActivityEvent) => void
  newEventId?: () => string
  now?: () => Date
}

interface InFlightTool {
  lineId: string
  runId: string
  toolName: string
  explicit?: TaskRef
  awaitingPermission: boolean
}

interface LineState {
  lineType?: string
  runId: string
  context?: TaskRef
}

interface SessionState {
  seq: number
  mainRunId?: string
  mainRunOpen: boolean
  lines: Map<string, LineState>
  inFlight: Map<string, InFlightTool>
  createdTasks: Map<string, TaskRef>
  // The last context of each subagent that stopped: a background subagent
  // starts again under the same agent_id to read its own background shell's
  // result (measured in HOL-175's prod test), and that work is still on its
  // own Task, not main's.
  stoppedContexts: Map<string, TaskRef | undefined>
}

const MAIN_LINE = 'main'

// A templated path that's missing on a given call arrives as "" (measured).
// A literal "${...}" is treated the same, in case a future version stops
// substituting it.
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && !value.startsWith('${') ? value : undefined
}

function firstResultJson(result: unknown): Record<string, unknown> | undefined {
  const content = (result as { content?: unknown } | undefined)?.content
  const first = Array.isArray(content) ? (content[0] as { type?: string; text?: string } | undefined) : undefined
  if (first?.type !== 'text' || typeof first.text !== 'string') {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(first.text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export function createChannelActivityReporter({
  send,
  newEventId = () => crypto.randomUUID(),
  now = () => new Date(),
}: ReporterOptions): ChannelActivityReporter {
  const sessions = new Map<string, SessionState>()

  function sessionFor(sessionId: string): SessionState {
    let session = sessions.get(sessionId)
    if (!session) {
      session = { seq: 0, mainRunOpen: false, lines: new Map(), inFlight: new Map(), createdTasks: new Map(), stoppedContexts: new Map() }
      sessions.set(sessionId, session)
    }
    return session
  }

  function emit(
    sessionId: string,
    session: SessionState,
    lineId: string,
    runId: string,
    kind: LiveActivityKind,
    fields: { toolName?: string; toolUseId?: string; durationMs?: number; outcome?: LiveActivityOutcome; explicit?: TaskRef } = {},
  ): void {
    session.seq += 1
    const line = session.lines.get(lineId)
    const { explicit, ...rest } = fields
    send({
      eventId: newEventId(),
      seq: session.seq,
      sessionId,
      runId,
      mode: 'channel',
      lineId,
      lineType: line?.lineType,
      at: now().toISOString(),
      kind,
      ...rest,
      taskId: explicit?.taskId,
      taskDisplayId: explicit?.taskDisplayId,
      // Every event of a line carries its context, not just tool events: a
      // run_ended routed to the Task's Project is what clears that Task's badge.
      contextTaskId: line?.context?.taskId,
      contextTaskDisplayId: line?.context?.taskDisplayId,
    })
  }

  // A subagent line normally exists from `SubagentStart`; one seen first
  // through a tool call is created on the spot. It starts from its own last
  // context if it ran before, else main's.
  function lineFor(sessionId: string, session: SessionState, agentId: string | undefined, agentType: string | undefined, promptId: string | undefined): [string, LineState] {
    if (!agentId) {
      let main = session.lines.get(MAIN_LINE)
      if (!main) {
        main = { runId: session.mainRunId ?? `${sessionId}:${promptId ?? 'unknown'}` }
        session.lines.set(MAIN_LINE, main)
      }
      return [MAIN_LINE, main]
    }
    let line = session.lines.get(agentId)
    if (!line) {
      const context = session.stoppedContexts.has(agentId) ? session.stoppedContexts.get(agentId) : session.lines.get(MAIN_LINE)?.context
      line = { lineType: agentType, runId: `${sessionId}:${agentId}`, context }
      session.lines.set(agentId, line)
    }
    return [agentId, line]
  }

  function closeInFlight(sessionId: string, session: SessionState, onLine: (lineId: string) => boolean): void {
    for (const [toolUseId, tool] of session.inFlight) {
      if (onLine(tool.lineId)) {
        emit(sessionId, session, tool.lineId, tool.runId, 'tool_finished', {
          toolName: tool.toolName,
          toolUseId,
          outcome: 'interrupted',
          explicit: tool.explicit,
        })
        session.inFlight.delete(toolUseId)
      }
    }
  }

  function handle(args: Record<string, unknown>): void {
    const kind = text(args.kind) as HookKind | undefined
    const sessionId = text(args.sessionId)
    if (!kind || !sessionId) {
      return
    }
    const session = sessionFor(sessionId)
    const promptId = text(args.promptId)
    const agentId = text(args.agentId)
    const agentType = text(args.agentType)
    const toolName = text(args.toolName)
    const toolUseId = text(args.toolUseId)

    switch (kind) {
      case 'turn_started': {
        // A message typed while a turn is running fires this hook right away,
        // with that turn's own prompt_id (measured in HOL-173): it joins the
        // running turn, it doesn't end it.
        const runId = `${sessionId}:${promptId ?? 'unknown'}`
        if (session.mainRunOpen && session.mainRunId === runId) {
          return
        }
        // A denied tool or an interrupted turn never reports an end, so the
        // next turn closes whatever the main line left open. Subagent lines
        // are left alone: a background subagent is still running.
        closeInFlight(sessionId, session, (lineId) => lineId === MAIN_LINE)
        if (session.mainRunOpen && session.mainRunId) {
          emit(sessionId, session, MAIN_LINE, session.mainRunId, 'run_ended', { outcome: 'interrupted' })
        }
        session.mainRunId = runId
        session.mainRunOpen = true
        const [, main] = lineFor(sessionId, session, undefined, undefined, promptId)
        main.runId = session.mainRunId
        // Each turn starts on no Task, same as its metrics (Marcos, HOL-176):
        // a session is open-ended, and the next message may have nothing to
        // do with the last Task touched. Subagents still start from the
        // context of the turn that spawned them.
        main.context = undefined
        emit(sessionId, session, MAIN_LINE, main.runId, 'run_started')
        return
      }

      case 'tool_started': {
        if (!toolName || !toolUseId) {
          return
        }
        const [lineId, line] = lineFor(sessionId, session, agentId, agentType, promptId)
        const isHolodeckTool = text(args.mcpServer) !== undefined && text(args.mcpServer) === text(args.holodeckServer)
        const explicit = isHolodeckTool ? toTaskRef(text(args.taskId)) : undefined
        if (explicit) {
          line.context = explicit
        }
        session.inFlight.set(toolUseId, { lineId, runId: line.runId, toolName, explicit, awaitingPermission: false })
        emit(sessionId, session, lineId, line.runId, 'tool_started', { toolName, toolUseId, explicit })
        return
      }

      case 'tool_awaiting_permission': {
        // No tool_use_id on this hook (measured): it belongs to the latest
        // open call of the same tool on the same line.
        if (!toolName) {
          return
        }
        const [lineId, line] = lineFor(sessionId, session, agentId, agentType, promptId)
        const match = [...session.inFlight].reverse().find(([, tool]) => tool.lineId === lineId && tool.toolName === toolName && !tool.awaitingPermission)
        if (match) {
          match[1].awaitingPermission = true
        }
        emit(sessionId, session, lineId, match?.[1].runId ?? line.runId, 'tool_awaiting_permission', {
          toolName,
          toolUseId: match?.[0],
          explicit: match?.[1].explicit,
        })
        return
      }

      case 'tool_succeeded':
      case 'tool_failed': {
        if (!toolName || !toolUseId) {
          return
        }
        const started = session.inFlight.get(toolUseId)
        session.inFlight.delete(toolUseId)
        const [lineId, line] = started ? [started.lineId, session.lines.get(started.lineId)] : lineFor(sessionId, session, agentId, agentType, promptId)
        const created = session.createdTasks.get(toolUseId)
        session.createdTasks.delete(toolUseId)
        if (created && line) {
          line.context = created
        }
        const durationMs = Number.parseInt(text(args.durationMs) ?? '', 10)
        const outcome: LiveActivityOutcome = kind === 'tool_succeeded' ? 'success' : text(args.isInterrupt) === 'true' ? 'interrupted' : 'failure'
        emit(sessionId, session, lineId, started?.runId ?? line?.runId ?? `${sessionId}:${agentId ?? promptId ?? 'unknown'}`, 'tool_finished', {
          toolName,
          toolUseId,
          durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
          outcome,
          explicit: created ?? started?.explicit,
        })
        return
      }

      case 'subagent_started': {
        if (!agentId) {
          return
        }
        const [lineId, line] = lineFor(sessionId, session, agentId, agentType, promptId)
        emit(sessionId, session, lineId, line.runId, 'run_started')
        return
      }

      case 'subagent_stopped': {
        // A stop for a line never seen has nothing to close. Claude Code sent
        // two of these in HOL-175's prod test, for agent_ids with no
        // agent_type and no other event.
        const line = agentId ? session.lines.get(agentId) : undefined
        if (!agentId || !line) {
          return
        }
        closeInFlight(sessionId, session, (id) => id === agentId)
        emit(sessionId, session, agentId, line.runId, 'run_ended', { outcome: 'success' })
        session.stoppedContexts.set(agentId, line.context)
        session.lines.delete(agentId)
        return
      }

      case 'turn_stopped':
      case 'turn_failed': {
        if (!session.mainRunOpen || !session.mainRunId) {
          return
        }
        emit(sessionId, session, MAIN_LINE, session.mainRunId, 'run_ended', { outcome: kind === 'turn_stopped' ? 'success' : 'error' })
        session.mainRunOpen = false
        return
      }

      case 'session_ended': {
        closeInFlight(sessionId, session, () => true)
        for (const [lineId, line] of session.lines) {
          if (lineId !== MAIN_LINE) {
            emit(sessionId, session, lineId, line.runId, 'run_ended', { outcome: 'interrupted' })
          }
        }
        const mainRunId = session.mainRunId ?? `${sessionId}:${promptId ?? 'unknown'}`
        if (session.mainRunOpen) {
          emit(sessionId, session, MAIN_LINE, mainRunId, 'run_ended', { outcome: 'interrupted' })
        }
        emit(sessionId, session, MAIN_LINE, mainRunId, 'session_ended')
        sessions.delete(sessionId)
        return
      }
    }
  }

  return {
    handleHookCall(args) {
      try {
        handle(args)
      } catch {
        // A hook must never fail the tool call it's attached to.
      }
      return { content: [{ type: 'text', text: 'ok' }] }
    },

    observeCreatedTask(toolUseId, result) {
      if (!toolUseId || (result as { isError?: boolean } | undefined)?.isError) {
        return
      }
      const parsed = firstResultJson(result)
      const taskId = typeof parsed?.id === 'string' ? parsed.id : undefined
      const taskDisplayId = typeof parsed?.taskId === 'string' ? parsed.taskId : undefined
      if (!taskId && !taskDisplayId) {
        return
      }
      for (const session of sessions.values()) {
        if (session.inFlight.has(toolUseId)) {
          session.createdTasks.set(toolUseId, { taskId, taskDisplayId })
          return
        }
      }
    },
  }
}
