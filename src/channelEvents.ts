import type {
  AgentAddedToProjectEvent,
  AgentInstructionSentEvent,
  AgentInstructionsUpdatedEvent,
  AgentMentionedEvent,
  AgentRemovedFromProjectEvent,
  ScheduledCheckDueEvent,
  SubscriptionMatchedEvent,
} from './agentConnection.js'

// What Claude Code needs to show one event in the session: `content` is the
// body of the `<channel>` tag and every `meta` entry becomes an attribute on
// it (HOL-130, https://code.claude.com/docs/en/channels-reference). Meta keys
// must be plain identifiers (letters, digits, underscores) - anything else is
// silently dropped by Claude Code, which is why these are `project_id`, not
// `project-id`.
export interface ChannelNotification {
  content: string
  meta: Record<string, string>
}

export type ChannelEvent =
  | SubscriptionMatchedEvent
  | AgentInstructionSentEvent
  | ScheduledCheckDueEvent
  | AgentInstructionsUpdatedEvent
  | AgentAddedToProjectEvent
  | AgentRemovedFromProjectEvent
  | AgentMentionedEvent

// The push events are deliberately minimal ("something changed, go look",
// PLAN.md 9: a push is never the authoritative payload), so each body says
// what happened and which Holodeck tool to reach for next - the model
// receiving it has no other way to know what these mean. Meta is dropped of
// undefined values first: `meta` is `Record<string, string>`.
export function describeChannelEvent(event: ChannelEvent): ChannelNotification {
  switch (event.type) {
    case 'subscription_matched': {
      const task = event.taskId ? ` on task ${event.taskId}` : ''
      return {
        content: `Your Holodeck subscription "${event.data.subscriptionName}" matched${task} (project ${event.projectId}). Something relevant changed: look at ${event.taskId ? 'that task with get_task' : 'the project'} to see what, and act on it if it's yours to act on.`,
        meta: compact({
          event: event.type,
          project_id: event.projectId,
          task_id: event.taskId,
          subscription_id: event.data.subscriptionId,
        }),
      }
    }
    case 'agent_instruction_sent':
      return {
        content:
          'Your owner sent you a direct instruction from the Holodeck Web UI. Read it with the list_my_instructions tool (reading it is what marks it as seen), then follow it.',
        meta: { event: event.type, instruction_id: event.data.instructionId },
      }
    case 'scheduled_check_due': {
      const matching = event.data.queryResult?.taskIds.length
        ? `\n\nTasks matching this check's query: ${event.data.queryResult.taskIds.join(', ')}`
        : ''
      return {
        content: `Your scheduled check "${event.data.name}" is due.\n\nInstruction: ${event.data.instruction}${matching}`,
        meta: compact({
          event: event.type,
          check_id: event.data.checkId,
          project_id: event.projectId,
          task_id: event.taskId,
        }),
      }
    }
    case 'agent_instructions_updated':
      return {
        content:
          'Your persona/instructions were just edited in Holodeck. Re-read them with get_my_context, and check with list_my_subscriptions whether your event subscriptions still make sense.',
        meta: { event: event.type },
      }
    case 'agent_mentioned': {
      const where = event.data.taskDisplayId ? `task ${event.data.taskDisplayId}` : 'an intention'
      const who = event.data.authorName ? event.data.authorName : 'Someone'
      return {
        content: `${who} tagged you in a note on ${where} in Holodeck. Read it with the list_my_mentions tool (reading it is what marks it as seen), then act on what it asks and answer with add_interaction.`,
        meta: compact({
          event: event.type,
          project_id: event.projectId,
          task_id: event.taskId,
          mention_id: event.data.mentionId,
        }),
      }
    }
    case 'agent_added_to_project':
      return {
        content: `You were added to a Holodeck project (id ${event.projectId}). Consider whether it needs event subscriptions of its own (subscribe_to_event).`,
        meta: { event: event.type, project_id: event.projectId },
      }
    case 'agent_removed_from_project':
      return {
        content: `You were removed from a Holodeck project (id ${event.projectId}). You no longer have access to it; drop anything in progress there.`,
        meta: { event: event.type, project_id: event.projectId },
      }
  }
}

// How long the connection has to have been down before a reconnect is
// worth a turn of the model. A drop-and-retry of a second or two (a proxy
// recycling an idle stream, a brief network hiccup) leaves a window so small
// that asking the Agent to re-check everything each time costs far more
// than it protects; a real outage (laptop asleep, network gone, Holodeck
// restarting) is what the reconcile is for. The very first connect always
// reconciles: whatever happened while the session was closed is exactly the
// case this exists for.
export const RECONCILE_AFTER_GAP_MS = 30_000

export function shouldReconcileOnConnect(droppedAt: number | undefined, now: number): boolean {
  return droppedAt === undefined || now - droppedAt >= RECONCILE_AFTER_GAP_MS
}

// Sent when the push connection is established and shouldReconcileOnConnect
// says it is worth it. A push is never replayed (PLAN.md 9, "Missed events":
// reconcile, don't replay), so anything that happened while this session was
// closed, or the connection was down, is simply gone - this is what makes the
// Agent go and look at current state instead. Tells it to stay quiet when
// there is nothing to do, since this starts a turn in the session by itself.
export function describeChannelConnected(agentName: string): ChannelNotification {
  return {
    content: `You are now connected to Holodeck as ${agentName}. While this session was closed, or the connection was down, events may have been missed. Check what needs your attention now: Tasks assigned to you that aren't finished (list_tasks with assignedToMe), any direct instruction from your owner you haven't read (list_my_instructions), and any note that tagged you that you haven't read (list_my_mentions). Act on what you find. If nothing needs attention, don't say anything.`,
    meta: { event: 'connected' },
  }
}

// Not one of the pushed events: this connection stopped on purpose. Sent so
// the session isn't left silently waiting for events that will never come.
export function describeChannelStopped(reason: 'stop_requested' | 'replaced'): ChannelNotification {
  return reason === 'stop_requested'
    ? {
        content:
          'Your owner asked you to stop, from the Holodeck Web UI. Stop what you are doing. This channel is now disconnected: no more Holodeck events will arrive until this session is restarted.',
        meta: { event: 'agent_stop_requested' },
      }
    : {
        content:
          'This Holodeck channel was replaced by another session running the same Agent. This session has disconnected: no more Holodeck events will arrive here, and its Holodeck tools are disabled. Only one session can hold an Agent at a time; stop acting as this Agent here.',
        meta: { event: 'connection_replaced' },
      }
}

function compact(meta: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(meta).filter((entry): entry is [string, string] => entry[1] !== undefined))
}
