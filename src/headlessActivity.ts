import type { LiveActivityEvent, LiveActivityKind, LiveActivityOutcome, TaskRef } from './liveActivityEvents.js'
import { toTaskRef } from './liveActivityEvents.js'

// Turns a Headless run's `claude -p --output-format stream-json` output into V2
// live activity events (docs/agent-live-activity-v2.md, section 6.5, in
// task-manager; HOL-179). The Headless counterpart of channelActivity.ts: a
// spawned run has no hooks, so this reads the stream instead, and keeps only
// ids, names and timings, never tool input or output (apart from a Holodeck
// tool's own `taskId` argument, and the id of a Task `create_task` returns).
//
// Measured on Claude Code 2.1.282 (HOL-179 spike, 2026-09-27):
// - `assistant`/`user` messages carry an ISO `timestamp`; a `tool_use` block
//   is closed by the `tool_result` with its id, `is_error` saying how it went.
// - A message produced inside a subagent carries `parent_tool_use_id`: the id
//   of the `Agent` tool call that launched it. `system/task_started` links that
//   id to the subagent's `task_id` (the same agent id a Channel's hooks report,
//   so it is used as the line id) and gives its `subagent_type`;
//   `system/task_notification` (`status`) says it ended. A background subagent's
//   `Agent` call returns at once, and the subagent works on after it.
// - One process can emit several `result` messages: when a background subagent
//   finishes, the session goes on with another turn. So the run ends when the
//   process exits (`finish`), never on a `result`.
//
// Runs: the main line's run is the whole process, and its id is the queue
// entry's (the backend's lease and metrics key on it); each subagent is its own
// run, `${entryId}:${agentId}`. The entry's Task is the explicit reference on
// every run's `run_started`, subagents included (Marcos, HOL-179): the whole
// process exists for that Task, so a subagent's work counts towards it in
// metrics even when it never names a Task itself (unlike a Channel subagent,
// whose session is open-ended). Each line starts from main's current context,
// and a Holodeck tool call naming another Task moves it, as for a Channel.

export interface HeadlessActivityReporter {
  // One call per stdout line. Never throws.
  handleLine(line: string): void
  // The process exited: closes whatever is still open and ends the session.
  finish(outcome: LiveActivityOutcome): void
}

interface ReporterOptions {
  entryId: string
  task: TaskRef
  // Tool names of the run's own Holodeck MCP server start with this.
  holodeckToolPrefix: string
  send: (event: LiveActivityEvent) => void
  newEventId?: () => string
  now?: () => Date
}

interface LineState {
  lineType?: string
  runId: string
  context?: TaskRef
}

interface InFlightTool {
  lineId: string
  runId: string
  toolName: string
  startedAt: number
  explicit?: TaskRef
}

interface ContentBlock {
  type?: string
  id?: string
  name?: string
  input?: { taskId?: unknown }
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}

interface StreamMessage {
  type?: string
  subtype?: string
  timestamp?: string
  parent_tool_use_id?: string | null
  message?: { content?: ContentBlock[] | string }
  task_id?: string
  tool_use_id?: string
  subagent_type?: string
  status?: string
}

const MAIN_LINE = 'main'

// `task_notification` statuses; anything else ends the subagent as interrupted.
const SUBAGENT_OUTCOME: Record<string, LiveActivityOutcome> = { completed: 'success', failed: 'error' }

// A `create_task` result is JSON text with the new Task's `id` and `taskId`.
function createdTaskRef(content: unknown): TaskRef | undefined {
  const first = Array.isArray(content) ? (content[0] as { type?: string; text?: unknown } | undefined) : undefined
  const raw = typeof content === 'string' ? content : first?.type === 'text' && typeof first.text === 'string' ? first.text : undefined
  if (!raw) {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as { id?: unknown; taskId?: unknown }
    const taskId = typeof parsed.id === 'string' ? parsed.id : undefined
    const taskDisplayId = typeof parsed.taskId === 'string' ? parsed.taskId : undefined
    return taskId || taskDisplayId ? { taskId, taskDisplayId } : undefined
  } catch {
    return undefined
  }
}

export function createHeadlessActivityReporter({
  entryId,
  task,
  holodeckToolPrefix,
  send,
  newEventId = () => crypto.randomUUID(),
  now = () => new Date(),
}: ReporterOptions): HeadlessActivityReporter {
  // One process is one entry, so the entry id also serves as the session id
  // (Claude Code's own arrives only with the first message, after run_started).
  const sessionId = entryId
  let seq = 0
  let finished = false
  const lines = new Map<string, LineState>([[MAIN_LINE, { runId: entryId, context: task }]])
  // `Agent` tool_use id -> subagent (agent) id, from `task_started`.
  const agentByToolUse = new Map<string, string>()
  const inFlight = new Map<string, InFlightTool>()

  function emit(
    lineId: string,
    runId: string,
    kind: LiveActivityKind,
    at: Date,
    fields: { toolName?: string; toolUseId?: string; durationMs?: number; outcome?: LiveActivityOutcome; explicit?: TaskRef } = {},
  ): void {
    seq += 1
    const line = lines.get(lineId)
    const { explicit, ...rest } = fields
    send({
      eventId: newEventId(),
      seq,
      sessionId,
      runId,
      mode: 'headless',
      lineId,
      lineType: line?.lineType,
      at: at.toISOString(),
      kind,
      ...rest,
      taskId: explicit?.taskId,
      taskDisplayId: explicit?.taskDisplayId,
      contextTaskId: line?.context?.taskId,
      contextTaskDisplayId: line?.context?.taskDisplayId,
    })
  }

  // A subagent line opens on `task_started`; one seen first through its own
  // messages (no `task_started`, e.g. a future version) opens there, keyed by
  // the launching tool call. Either way it starts from main's context.
  function lineFor(parentToolUseId: string | null | undefined, at: Date): [string, LineState] {
    if (!parentToolUseId) {
      return [MAIN_LINE, lines.get(MAIN_LINE) as LineState]
    }
    const lineId = agentByToolUse.get(parentToolUseId) ?? parentToolUseId
    let line = lines.get(lineId)
    if (!line) {
      line = { runId: `${entryId}:${lineId}`, context: lines.get(MAIN_LINE)?.context }
      lines.set(lineId, line)
      emit(lineId, line.runId, 'run_started', at, { explicit: task })
    }
    return [lineId, line]
  }

  function closeInFlight(at: Date, onLine: (lineId: string) => boolean): void {
    for (const [toolUseId, tool] of inFlight) {
      if (onLine(tool.lineId)) {
        emit(tool.lineId, tool.runId, 'tool_finished', at, { toolName: tool.toolName, toolUseId, outcome: 'interrupted', explicit: tool.explicit })
        inFlight.delete(toolUseId)
      }
    }
  }

  function endSubagent(lineId: string, outcome: LiveActivityOutcome, at: Date): void {
    const line = lines.get(lineId)
    if (!line || lineId === MAIN_LINE) {
      return
    }
    closeInFlight(at, (id) => id === lineId)
    emit(lineId, line.runId, 'run_ended', at, { outcome })
    lines.delete(lineId)
  }

  function handleMessage(message: StreamMessage): void {
    const parsedAt = message.timestamp ? new Date(message.timestamp) : undefined
    const at = parsedAt && !Number.isNaN(parsedAt.getTime()) ? parsedAt : now()

    if (message.type === 'system') {
      if (message.subtype === 'task_started' && message.task_id && message.tool_use_id) {
        agentByToolUse.set(message.tool_use_id, message.task_id)
        const line: LineState = { lineType: message.subagent_type, runId: `${entryId}:${message.task_id}`, context: lines.get(MAIN_LINE)?.context }
        if (!lines.has(message.task_id)) {
          lines.set(message.task_id, line)
          emit(message.task_id, line.runId, 'run_started', at, { explicit: task })
        }
      } else if (message.subtype === 'task_notification' && message.task_id) {
        endSubagent(message.task_id, SUBAGENT_OUTCOME[message.status ?? ''] ?? 'interrupted', at)
      }
      return
    }

    if (message.type !== 'assistant' && message.type !== 'user') {
      return
    }
    const content = message.message?.content
    if (!Array.isArray(content)) {
      return
    }
    for (const block of content) {
      if (block.type === 'tool_use' && block.id && block.name) {
        const [lineId, line] = lineFor(message.parent_tool_use_id, at)
        const isHolodeckTool = block.name.startsWith(holodeckToolPrefix)
        const explicit = isHolodeckTool && typeof block.input?.taskId === 'string' ? toTaskRef(block.input.taskId) : undefined
        if (explicit) {
          line.context = explicit
        }
        inFlight.set(block.id, { lineId, runId: line.runId, toolName: block.name, startedAt: at.getTime(), explicit })
        emit(lineId, line.runId, 'tool_started', at, { toolName: block.name, toolUseId: block.id, explicit })
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        const started = inFlight.get(block.tool_use_id)
        if (!started) {
          continue
        }
        inFlight.delete(block.tool_use_id)
        const line = lines.get(started.lineId)
        const created = started.toolName === `${holodeckToolPrefix}create_task` && !block.is_error ? createdTaskRef(block.content) : undefined
        if (created && line) {
          line.context = created
        }
        emit(started.lineId, started.runId, 'tool_finished', at, {
          toolName: started.toolName,
          toolUseId: block.tool_use_id,
          durationMs: Math.max(0, at.getTime() - started.startedAt),
          outcome: block.is_error ? 'failure' : 'success',
          explicit: created ?? started.explicit,
        })
      }
    }
  }

  // Sent as soon as the reporter exists (the process was just spawned), so the
  // run shows before Claude Code's first message.
  emit(MAIN_LINE, entryId, 'run_started', now(), { explicit: task })

  return {
    handleLine(line) {
      if (finished) {
        return
      }
      try {
        handleMessage(JSON.parse(line) as StreamMessage)
      } catch {
        // Not a stream-json line, or not one this understands: not activity.
      }
    },
    finish(outcome) {
      if (finished) {
        return
      }
      finished = true
      const at = now()
      closeInFlight(at, () => true)
      for (const lineId of [...lines.keys()]) {
        endSubagent(lineId, 'interrupted', at)
      }
      emit(MAIN_LINE, entryId, 'run_ended', at, { outcome })
      emit(MAIN_LINE, entryId, 'session_ended', at)
    },
  }
}
