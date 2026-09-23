import { createActivityDeliveryQueue } from './activityDelivery.js'

// "Agent live activity" Intention (docs/agent-live-activity.md in
// task-manager), Task 3/7 (HOL-163). Everything a `channel run` process
// needs to turn Claude Code's own hooks into events at
// backend/src/domains/agentActivity/schema.ts's `POST /agent/activity`
// endpoint (HOL-162, already built) — kept out of channelServer.ts itself so
// that file stays about the MCP server, not this feature's own plumbing.
//
// The reduction the design promises ("no tool inputs or outputs in the live
// view") happens BEFORE this module is ever involved: `agentCommands.ts`'s
// own `--settings` only ever templates a small, fixed set of fields
// (`${tool_name}`, `${tool_use_id}`, `${duration_ms}`, ...) into the hook's
// `input` — Claude Code substitutes those into plain strings itself, so the
// full `tool_input`/`tool_response` (a file's contents, a command's stdout)
// is never handed to this process at all, let alone held here for even one
// line of code. This module only ever sees what that template already
// admitted.

// Mirrors backend/src/domains/agentActivity/schema.ts's `AgentActivityEvent`
// exactly — this Task's wire contract with that endpoint. A change to
// either side needs a matching change to the other. `mode` allows
// `'headless'` too (not just this file's own `'channel'`) because
// headlessActivity.ts (HOL-164) reuses this same type for its own events,
// rather than each transport keeping a parallel copy of an identical shape.
export type AgentActivityMode = 'channel' | 'headless'
export type AgentActivityEvent =
  | { type: 'run_started'; runId: string; taskId?: string; mode: AgentActivityMode; at: string }
  | { type: 'run_ended'; runId: string; taskId?: string; mode: AgentActivityMode; at: string }
  | { type: 'tool_started'; runId: string; taskId?: string; mode: AgentActivityMode; at: string; toolName: string; toolUseId: string }
  | {
      type: 'tool_finished'
      runId: string
      taskId?: string
      mode: AgentActivityMode
      at: string
      toolName: string
      toolUseId: string
      durationMs: number
    }

// A run = one Claude Code turn (UserPromptSubmit -> Stop), matching the
// design's own model. Claude Code's own `session_id` stays constant for the
// whole process (channelServer.ts starts one process per session), but
// `prompt_id` is fresh per turn and is already handed to every hook this
// Task wires (PreToolUse/PostToolUse/UserPromptSubmit/Stop all carry it,
// confirmed against real hook payloads in the HOL-137 spike) — so there is
// no need to mint our own id. Both are combined (not `prompt_id` alone) only
// as a margin against some future Claude Code version reusing prompt ids
// across sessions; nothing here depends on that actually happening today.
function runIdFrom(args: Record<string, unknown>): string | undefined {
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : undefined
  const promptId = typeof args.promptId === 'string' ? args.promptId : undefined
  return sessionId && promptId ? `${sessionId}:${promptId}` : undefined
}

// The Holodeck tools whose calls this Task watches to maintain a "current
// Task" for the channel process (spike item 5) — exported so
// channelServer.ts's existing tool-forwarding branch knows which calls to
// look at, without duplicating this list. Every Task-scoped tool Holodeck
// has, not just the `in_progress`-lifecycle ones (start_working_on_task/
// pause_work/finish_status_work/change_task_status) — widened after a real
// gap: an Agent whose job is reviewing a Task in `review`, or refining one
// in `backlog`, may never call those (their names, and their side effects
// on status/assignee, don't fit that work), but it WILL call `get_task`,
// `add_interaction`, `update_task`, `raise_blocked`, etc. as a completely
// normal part of doing that work regardless of the Task's own status.
// `resolve_blocked` (takes a `blockId`, not a `taskId`) and `list_tasks`/
// `create_task` (never about one specific already-existing Task the way
// "current" means here) are left out on purpose.
export const TRACKED_TASK_TOOLS = new Set([
  'start_working_on_task',
  'get_task',
  'get_task_activity',
  'update_task',
  'set_resolution',
  'change_task_assignee',
  'raise_blocked',
  'add_interaction',
  'set_active_work',
  'pause_work',
  'finish_status_work',
  'change_task_status',
])

// A Task at either of these can't be worked on any more — the point at
// which current-Task tracking clears rather than keeps pointing at it
// (backend/src/domains/task/service.ts's own FIXED_TASK_STATUSES).
const TERMINAL_TASK_STATUSES = new Set(['done', 'cancelled'])

// Every internal Task id this codebase hands out is a Prisma-generated
// cuid: lowercase letters and digits only, no hyphen (seen throughout this
// session's own ids, e.g. `cmucypx8x001th0yahzuskp72`). A display id
// (`"HOL-165"`) never matches this — always uppercase letters, a hyphen,
// then digits. Distinguishing the two matters because the backend's own
// `taskId` is a real Postgres foreign key (schema.prisma's `AgentRun.task`
// relation): sending it a display id instead of the row's actual id would
// fail the constraint, not degrade gracefully. This lets most Task-scoped
// tool calls adopt a NEW current Task directly from their own `taskId`
// argument, with no extra lookup, whenever an Agent already has the
// canonical id in hand (the overwhelmingly common case — it's what
// `get_task`'s own result just handed back) — without ever trusting an
// unresolved display id enough to send it onward.
function looksLikeInternalTaskId(identifier: string): boolean {
  return /^[a-z][a-z0-9]{19,}$/.test(identifier)
}

export interface ActivityReporter {
  // The hidden hook-receiving tool's own handler (channelServer.ts's
  // CallToolRequestSchema). Never throws, never awaits the network — a
  // mcp_tool hook blocks the tool call on this returning.
  handleHookCall(args: Record<string, unknown>): { content: { type: 'text'; text: string }[] }
  // Called after a successful forwarded call to one of TRACKED_TASK_TOOLS,
  // to update the current Task. `result` is that call's own CallToolResult
  // (its JSON text is parsed here, defensively — a shape this doesn't
  // recognize just means nothing is learned from it, never a throw).
  observeTaskToolCall(toolName: string, args: unknown, result: unknown): void
  stop(): void
}

function firstResultText(result: unknown): Record<string, unknown> | undefined {
  const content = (result as { content?: unknown } | undefined)?.content
  if (!Array.isArray(content) || content.length === 0) {
    return undefined
  }
  const first = content[0] as { type?: string; text?: string } | undefined
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    return undefined
  }
  try {
    const parsed = JSON.parse(first.text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export function createActivityReporter(
  serverUrl: string,
  getToken: () => Promise<string>,
  log: (message: string) => void,
): ActivityReporter {
  // Both the internal id (what the backend's `taskId` FK needs) and the
  // display id (what an Agent's own tool arguments name a Task by) are
  // tracked, so a later change_task_status/pause_work/finish_status_work
  // call naming the Task either way can still be recognized as "the current
  // one" without a further round trip just to resolve it.
  let currentTaskId: string | undefined
  let currentDisplayId: string | undefined
  // The run a Stop hasn't yet closed — SessionEnd's own fallback (the
  // process ending, or being interrupted, without a matching Stop) closes
  // it rather than leaving it open forever.
  let openRunId: string | undefined

  // Queue+drain+retry is shared with headlessActivity.ts (activityDelivery.ts's
  // own note) — this file only ever calls `enqueue`, never touches the
  // network directly. `--verbose` isn't checked here: this always goes to
  // the same log() every other lifecycle event already uses, so "did the
  // hook even fire?" can be answered from that one file regardless.
  const delivery = createActivityDeliveryQueue<AgentActivityEvent>(serverUrl, getToken, log)
  const enqueue = delivery.enqueue

  function clearCurrentTask(): void {
    currentTaskId = undefined
    currentDisplayId = undefined
  }
  function namesCurrentTask(identifier: string): boolean {
    return identifier === currentTaskId || identifier === currentDisplayId
  }

  function observeTaskToolCall(toolName: string, args: unknown, result: unknown): void {
    if ((result as { isError?: boolean } | undefined)?.isError) {
      return
    }
    const a = (args ?? {}) as Record<string, unknown>
    const identifier = typeof a.taskId === 'string' ? a.taskId : undefined

    // `get_task`/`start_working_on_task` are the only two whose RESULT
    // carries the Task's canonical id (get_task's full row;
    // start_working_on_task's own confirmation) — trusted unconditionally,
    // last one wins, same as before this Task's tools were widened.
    if (toolName === 'start_working_on_task' || toolName === 'get_task') {
      const parsed = firstResultText(result)
      const id = typeof parsed?.id === 'string' ? parsed.id : undefined
      const displayId = typeof parsed?.taskId === 'string' ? parsed.taskId : undefined
      const status = typeof parsed?.status === 'string' ? parsed.status : undefined
      if (id && status && TERMINAL_TASK_STATUSES.has(status)) {
        clearCurrentTask()
      } else if (id) {
        currentTaskId = id
        currentDisplayId = displayId
      }
      return
    }

    // Every other tracked tool only ever gets an identifier in its own
    // ARGUMENTS, never a canonical id back in its result. Adopt it directly
    // when it's already in canonical form (looksLikeInternalTaskId) — an
    // Agent reviewing/refining a Task almost always already has that exact
    // id in hand by the time it calls add_interaction/update_task/etc.,
    // since that's what get_task handed it moments earlier. A display id
    // ("HOL-165") is never adopted from here (the FK risk
    // looksLikeInternalTaskId's own comment explains) — it only gets used
    // below, to recognize a call that's still about the Task already
    // tracked (e.g. change_task_status clearing it).
    if (identifier && looksLikeInternalTaskId(identifier) && identifier !== currentTaskId) {
      currentTaskId = identifier
      currentDisplayId = undefined // Unknown until get_task/start_working_on_task confirms it.
    }

    if (toolName === 'change_task_status' && identifier && namesCurrentTask(identifier)) {
      // The new status is right there in the call's own arguments — no
      // result to parse, and no round trip needed to learn it.
      const status = typeof a.status === 'string' ? a.status : undefined
      if (status && TERMINAL_TASK_STATUSES.has(status)) {
        clearCurrentTask()
      }
    }
    // The rest (pause_work/finish_status_work/set_active_work/
    // get_task_activity/raise_blocked/add_interaction/update_task/
    // set_resolution/change_task_assignee) never change status themselves,
    // so there is nothing else here for current-Task tracking to react to
    // beyond the adoption above.
  }

  function handleHookCall(args: Record<string, unknown>): { content: { type: 'text'; text: string }[] } {
    const kind = typeof args.kind === 'string' ? args.kind : undefined
    const at = new Date().toISOString()
    const taskId = currentTaskId
    // One compact line per hook call — this is the only way to confirm "did
    // the hook actually fire?" from outside the process (the per-Agent log
    // file this already goes to, MAX_LOG_BYTES's own rotation covers the
    // volume). Logged unconditionally, not just under --verbose: --verbose
    // only controls what agentCommands.ts prints to the terminal, this file
    // never sees that flag and shouldn't need to.
    log(`agent activity: received ${String(kind)}${typeof args.toolName === 'string' ? ` (${args.toolName})` : ''}`)

    switch (kind) {
      case 'run_started': {
        const runId = runIdFrom(args)
        if (runId) {
          openRunId = runId
          enqueue({ type: 'run_started', runId, taskId, mode: 'channel', at })
        }
        break
      }
      case 'tool_started': {
        const runId = runIdFrom(args) ?? openRunId
        const toolName = typeof args.toolName === 'string' ? args.toolName : undefined
        const toolUseId = typeof args.toolUseId === 'string' ? args.toolUseId : undefined
        if (runId && toolName && toolUseId) {
          enqueue({ type: 'tool_started', runId, taskId, mode: 'channel', at, toolName, toolUseId })
        }
        break
      }
      case 'tool_finished': {
        const runId = runIdFrom(args) ?? openRunId
        const toolName = typeof args.toolName === 'string' ? args.toolName : undefined
        const toolUseId = typeof args.toolUseId === 'string' ? args.toolUseId : undefined
        const durationMs = Number(args.durationMs)
        if (runId && toolName && toolUseId && Number.isFinite(durationMs)) {
          enqueue({ type: 'tool_finished', runId, taskId, mode: 'channel', at, toolName, toolUseId, durationMs })
        }
        break
      }
      case 'run_ended': {
        const runId = runIdFrom(args) ?? openRunId
        if (runId) {
          enqueue({ type: 'run_ended', runId, taskId, mode: 'channel', at })
          if (runId === openRunId) {
            openRunId = undefined
          }
        }
        break
      }
      case 'session_ended': {
        // SessionEnd carries no prompt_id (it's session-, not turn-scoped) —
        // this only ever closes a run Stop itself never got to.
        if (openRunId) {
          enqueue({ type: 'run_ended', runId: openRunId, taskId, mode: 'channel', at })
          openRunId = undefined
        }
        break
      }
    }
    // Not the raw hook stdout contract (channelServer.ts's own tools return
    // Holodeck's real results) — this is Claude Code reading an MCP tool's
    // result as if it were hook stdout (mcp_tool's own behavior): a fixed,
    // non-blocking acknowledgement is all that's ever needed here.
    return { content: [{ type: 'text', text: 'ok' }] }
  }

  return {
    handleHookCall,
    observeTaskToolCall,
    stop: delivery.stop,
  }
}
