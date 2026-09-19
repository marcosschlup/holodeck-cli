import type {
  AgentAddedToProjectEvent,
  AgentInstructionSentEvent,
  AgentInstructionsUpdatedEvent,
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
          'This Holodeck channel was replaced by another session running the same Agent, and this one has disconnected: no more Holodeck events will arrive here. Only one session can hold an Agent at a time.',
        meta: { event: 'connection_replaced' },
      }
}

function compact(meta: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(meta).filter((entry): entry is [string, string] => entry[1] !== undefined))
}
