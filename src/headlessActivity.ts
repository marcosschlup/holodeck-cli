import { createActivityDeliveryQueue } from './activityDelivery.js'

// V1 wire shape (`POST /agent/activity`). This module isn't wired to anything
// yet (the Headless daemon, HOL-131, doesn't exist); HOL-179 rewrites it onto
// V2's liveActivityEvents.ts.
type AgentActivityMode = 'channel' | 'headless'
type AgentActivityEvent =
  | { type: 'run_started'; runId: string; taskId?: string; mode: AgentActivityMode; at: string }
  | { type: 'run_ended'; runId: string; taskId?: string; mode: AgentActivityMode; at: string }
  | { type: 'tool_started'; runId: string; taskId?: string; mode: AgentActivityMode; at: string; toolName: string; toolUseId: string }
  | { type: 'tool_finished'; runId: string; taskId?: string; mode: AgentActivityMode; at: string; toolName: string; toolUseId: string; durationMs: number }

// "Agent live activity" Intention (docs/agent-live-activity.md in
// task-manager), Task 4/7 (HOL-164). The Headless counterpart to
// agentActivity.ts's Channel reporter: same wire shape
// (`AgentActivityEvent`), same delivery queue (activityDelivery.ts), but the
// raw source is a spawned `claude -p --output-format stream-json`
// process's stdout instead of Claude Code's own hooks — Headless gets no
// hooks at all (confirmed in the spike; there's nothing to receive one),
// so this parses the stream directly.
//
// The reduction the design promises happens HERE, in `handleLine`, the same
// way it happens in `--settings`'s own hook templates for Channel: a
// `tool_use` block's full `input` and a `tool_result` block's full
// `content` are read only far enough to know they exist, then discarded —
// only `{toolName, toolUseId, timestamp, computed duration}` is ever kept
// or enqueued, matching this Task's own scope item 2.
//
// Not built here (out of scope, HOL-131's own work): actually spawning the
// process, or deciding what `runId`/`taskId` are — this module receives
// both already resolved (an execution-queue entry's own id and Task,
// "exact and free" per this Task's own scope item 4), one call per line of
// stdout, from whoever does that spawning.

// The stream-json message shapes this cares about, reduced to just the
// fields used — not the full SDK message type, which also carries text/
// thinking blocks, usage, and other fields this never reads.
interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
}
interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
}
type ContentBlock = ToolUseBlock | ToolResultBlock | { type: string }

interface StreamMessage {
  type?: string
  // Verified in the spike (2026-09-22, real `claude -p --output-format
  // stream-json --verbose` run): every `tool_use`/`tool_result`-carrying
  // message has an ISO timestamp here. Falls back to wall-clock time below
  // if a future Claude Code version ever omits it, rather than throwing —
  // a slightly-off time beats a dropped event.
  timestamp?: string
  message?: { content?: ContentBlock[] }
}

export interface HeadlessRunContext {
  runId: string
  taskId?: string
}

export interface HeadlessActivityReporter {
  // One call per line of the spawned process's stdout. Never throws — a
  // line that isn't JSON, or is JSON but not a shape this recognizes, is
  // simply not activity and is ignored.
  handleLine(rawLine: string): void
  // Call when the process exits, however it exits. If a `result` message
  // already closed the run, this is a no-op — it exists for the run that
  // DIDN'T get one (killed, crashed, a truncated stream), so a run never
  // sits open forever just because the process never sent one.
  finalize(): void
  stop(): void
}

export function createHeadlessActivityReporter(
  ctx: HeadlessRunContext,
  serverUrl: string,
  getToken: () => Promise<string>,
  log: (message: string) => void,
): HeadlessActivityReporter {
  const delivery = createActivityDeliveryQueue<AgentActivityEvent>(serverUrl, getToken, log)

  // A run here is the WHOLE spawned process (one execution-queue entry),
  // not one turn the way Channel's is — a single Headless prompt can carry
  // many assistant/user message pairs before the final `result`, and
  // there's exactly one run to report regardless.
  let runStarted = false
  let runEnded = false
  // tool_use_id -> {toolName, startedAt} until its matching tool_result
  // arrives (verified in the spike: paired by `tool_use_id` across the
  // `assistant` message that started it and the following `user` message).
  const pendingToolUse = new Map<string, { toolName: string; startedAt: string }>()

  function ensureRunStarted(at: string): void {
    if (runStarted) {
      return
    }
    runStarted = true
    delivery.enqueue({ type: 'run_started', runId: ctx.runId, taskId: ctx.taskId, mode: 'headless', at })
  }

  function endRun(at: string): void {
    if (runEnded) {
      return
    }
    runEnded = true
    delivery.enqueue({ type: 'run_ended', runId: ctx.runId, taskId: ctx.taskId, mode: 'headless', at })
  }

  function handleLine(rawLine: string): void {
    const line = rawLine.trim()
    if (!line) {
      return
    }
    let parsed: StreamMessage
    try {
      parsed = JSON.parse(line)
    } catch {
      return // Not a stream-json line (stray stdout) — nothing to do with it.
    }
    const at = typeof parsed.timestamp === 'string' ? parsed.timestamp : new Date().toISOString()
    log(`agent activity: received ${String(parsed.type)}`)

    if (parsed.type === 'assistant' || parsed.type === 'user') {
      ensureRunStarted(at)
      for (const block of parsed.message?.content ?? []) {
        if (block.type === 'tool_use') {
          const toolUse = block as ToolUseBlock
          pendingToolUse.set(toolUse.id, { toolName: toolUse.name, startedAt: at })
          delivery.enqueue({
            type: 'tool_started',
            runId: ctx.runId,
            taskId: ctx.taskId,
            mode: 'headless',
            at,
            toolName: toolUse.name,
            toolUseId: toolUse.id,
          })
        } else if (block.type === 'tool_result') {
          const toolResult = block as ToolResultBlock
          const started = pendingToolUse.get(toolResult.tool_use_id)
          pendingToolUse.delete(toolResult.tool_use_id)
          if (started) {
            const durationMs = Math.max(0, Date.parse(at) - Date.parse(started.startedAt))
            delivery.enqueue({
              type: 'tool_finished',
              runId: ctx.runId,
              taskId: ctx.taskId,
              mode: 'headless',
              at,
              toolName: started.toolName,
              toolUseId: toolResult.tool_use_id,
              durationMs: Number.isFinite(durationMs) ? durationMs : 0,
            })
          }
          // No matching `tool_started` (this line arrived on its own, or a
          // process restart lost the pairing) — nothing to compute a
          // duration against, so nothing is published for it. Degrading to
          // "missing", never to a made-up duration.
        }
      }
      return
    }

    if (parsed.type === 'result') {
      // The final message: always closes the run, even if no assistant/
      // user message ever arrived (e.g. an auth failure before any turn
      // ran) — `ensureRunStarted` degrades that to a run that started and
      // ended at the same instant, same posture as the backend's own
      // out-of-order handling (HOL-162).
      ensureRunStarted(at)
      endRun(at)
    }
  }

  function finalize(): void {
    if (runStarted && !runEnded) {
      endRun(new Date().toISOString())
    }
  }

  return { handleLine, finalize, stop: delivery.stop }
}
