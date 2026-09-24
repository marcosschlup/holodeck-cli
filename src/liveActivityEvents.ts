// Agent live activity V2 wire contract: mirrors
// task-manager/backend/src/domains/agentActivityEvent/schema.ts
// (docs/agent-live-activity-v2.md, section 7.2). A change to either side
// needs the matching change on the other.

export type LiveActivityKind =
  | 'run_started'
  | 'run_ended'
  | 'session_ended'
  | 'tool_started'
  | 'tool_awaiting_permission'
  | 'tool_finished'

export type LiveActivityOutcome = 'success' | 'failure' | 'interrupted' | 'error'

export interface TaskRef {
  taskId?: string
  taskDisplayId?: string
}

export interface LiveActivityEvent {
  eventId: string
  seq: number
  sessionId: string
  runId: string
  mode: 'channel' | 'headless'
  lineId: string
  lineType?: string
  at: string
  kind: LiveActivityKind
  toolName?: string
  toolUseId?: string
  durationMs?: number
  outcome?: LiveActivityOutcome
  taskId?: string
  taskDisplayId?: string
  contextTaskId?: string
  contextTaskDisplayId?: string
}

// A Holodeck display id is the Project's taskPrefix (2-4 uppercase letters),
// a hyphen and the Task's number. Anything else is sent as an internal id; the
// backend resolves both and drops what isn't a Task this Agent can reach.
const DISPLAY_ID = /^[A-Z]{2,4}-\d+$/

export function toTaskRef(identifier: string | undefined): TaskRef | undefined {
  if (!identifier) {
    return undefined
  }
  return DISPLAY_ID.test(identifier) ? { taskDisplayId: identifier } : { taskId: identifier }
}
