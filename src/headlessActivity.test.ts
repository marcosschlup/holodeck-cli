import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createHeadlessActivityReporter } from './headlessActivity.js'
import type { LiveActivityEvent } from './liveActivityEvents.js'

const PREFIX = 'mcp__holodeck-agent__'

function reporter() {
  const events: LiveActivityEvent[] = []
  let id = 0
  const activity = createHeadlessActivityReporter({
    entryId: 'entry1',
    task: { taskId: 'task-a' },
    holodeckToolPrefix: PREFIX,
    send: (event) => events.push(event),
    newEventId: () => `e${++id}`,
    now: () => new Date('2026-09-27T12:00:00.000Z'),
  })
  const feed = (...messages: object[]) => messages.forEach((message) => activity.handleLine(JSON.stringify(message)))
  return { activity, events, feed }
}

const at = (seconds: number) => new Date(Date.parse('2026-09-27T12:00:00.000Z') + seconds * 1000).toISOString()
const toolUse = (id: string, name: string, seconds: number, input: object = {}, parent: string | null = null) => ({
  type: 'assistant',
  timestamp: at(seconds),
  parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_use', id, name, input }] },
})
const toolResult = (id: string, seconds: number, extra: object = {}, parent: string | null = null) => ({
  type: 'user',
  timestamp: at(seconds),
  parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_result', tool_use_id: id, ...extra }] },
})

// What matters of each event, for readable assertions.
const brief = (events: LiveActivityEvent[]) =>
  events.map((event) =>
    [event.kind, event.lineId, event.runId, event.toolName, event.outcome, event.durationMs, event.taskId ?? event.taskDisplayId, event.contextTaskId ?? event.contextTaskDisplayId]
      .map((value) => (value === undefined ? '-' : String(value)))
      .join(' '),
  )

describe('headless activity', () => {
  it('reports a normal run: the entry Task first, then the Task a Holodeck tool names, and create_task', () => {
    const { activity, events, feed } = reporter()
    feed(
      { type: 'system', subtype: 'init', session_id: 's1', cwd: 'C:\\repo' },
      toolUse('t1', `${PREFIX}get_task`, 1, { taskId: 'TES-12' }),
      toolResult('t1', 2),
      toolUse('t2', 'Bash', 3, { command: 'npm test' }),
      toolResult('t2', 7, { is_error: true }),
      toolUse('t3', `${PREFIX}create_task`, 8, { title: 'Follow-up' }),
      toolResult('t3', 9, { content: [{ type: 'text', text: JSON.stringify({ id: 'task-new', taskId: 'TES-13' }) }] }),
      { type: 'result', subtype: 'success', is_error: false },
      toolUse('t4', 'Read', 10),
      toolResult('t4', 10),
    )
    activity.finish('success')

    assert.deepEqual(brief(events), [
      'run_started main entry1 - - - task-a task-a',
      `tool_started main entry1 ${PREFIX}get_task - - TES-12 TES-12`,
      `tool_finished main entry1 ${PREFIX}get_task success 1000 TES-12 TES-12`,
      'tool_started main entry1 Bash - - - TES-12',
      'tool_finished main entry1 Bash failure 4000 - TES-12',
      `tool_started main entry1 ${PREFIX}create_task - - - TES-12`,
      `tool_finished main entry1 ${PREFIX}create_task success 1000 task-new task-new`,
      // A `result` doesn't end the run: the process may go on.
      'tool_started main entry1 Read - - - task-new',
      'tool_finished main entry1 Read success 0 - task-new',
      'run_ended main entry1 - success - - task-new',
      'session_ended main entry1 - - - - task-new',
    ])
    assert.deepEqual(
      events.map((event) => event.seq),
      events.map((_, index) => index + 1),
    )
    assert.ok(events.every((event) => event.mode === 'headless' && event.sessionId === 'entry1'))
  })

  it('gives a subagent its own line and run, from task_started to task_notification', () => {
    const { activity, events, feed } = reporter()
    // Shapes from the real spike: a backgrounded Explore subagent.
    feed(
      toolUse('toolu_agent', 'Agent', 1, { description: 'Read files', subagent_type: 'Explore' }),
      { type: 'system', subtype: 'task_started', task_id: 'ab205e6b', tool_use_id: 'toolu_agent', subagent_type: 'Explore', is_backgrounded: true },
      toolResult('toolu_agent', 1),
      toolUse('t_bash', 'Bash', 2),
      toolUse('t_read', 'Read', 3, { file_path: 'a.txt' }, 'toolu_agent'),
      toolResult('t_bash', 3),
      toolResult('t_read', 4, {}, 'toolu_agent'),
      { type: 'system', subtype: 'task_notification', task_id: 'ab205e6b', tool_use_id: 'toolu_agent', status: 'completed' },
    )
    activity.finish('success')

    const subagent = events.filter((event) => event.lineId === 'ab205e6b')
    assert.deepEqual(brief(subagent), [
      'run_started ab205e6b entry1:ab205e6b - - - task-a task-a',
      'tool_started ab205e6b entry1:ab205e6b Read - - - task-a',
      'tool_finished ab205e6b entry1:ab205e6b Read success 1000 - task-a',
      'run_ended ab205e6b entry1:ab205e6b - success - - task-a',
    ])
    assert.ok(subagent.every((event) => event.lineType === 'Explore'))
    assert.deepEqual(
      events.filter((event) => event.lineId === 'main').map((event) => `${event.kind} ${event.toolName ?? '-'}`),
      ['run_started -', 'tool_started Agent', 'tool_finished Agent', 'tool_started Bash', 'tool_finished Bash', 'run_ended -', 'session_ended -'],
    )
  })

  it('closes everything open when the process is killed mid-tool', () => {
    const { activity, events, feed } = reporter()
    feed(
      toolUse('toolu_agent', 'Agent', 1),
      { type: 'system', subtype: 'task_started', task_id: 'sub1', tool_use_id: 'toolu_agent', subagent_type: 'general-purpose' },
      toolUse('t_sub', 'Bash', 2, {}, 'toolu_agent'),
      toolUse('t_main', 'Bash', 2),
    )
    activity.finish('interrupted')
    activity.handleLine(JSON.stringify(toolResult('t_main', 5)))

    assert.deepEqual(brief(events.slice(-5)), [
      'tool_finished sub1 entry1:sub1 Bash interrupted - - task-a',
      'tool_finished main entry1 Bash interrupted - - task-a',
      'run_ended sub1 entry1:sub1 - interrupted - - task-a',
      'run_ended main entry1 - interrupted - - task-a',
      'session_ended main entry1 - - - - task-a',
    ])
  })

  it('opens a subagent line from its messages when task_started never came, and ignores junk', () => {
    const { events, feed, activity } = reporter()
    activity.handleLine('not json')
    feed({ type: 'rate_limit_event' }, toolUse('t1', 'Grep', 1, {}, 'toolu_x'))
    assert.deepEqual(brief(events.slice(1)), ['run_started toolu_x entry1:toolu_x - - - task-a task-a', 'tool_started toolu_x entry1:toolu_x Grep - - - task-a'])
  })
})
