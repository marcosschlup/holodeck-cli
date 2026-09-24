import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createChannelActivityReporter } from './channelActivity.js'
import type { LiveActivityEvent } from './liveActivityEvents.js'

// Hook inputs arrive the way agentCommands.ts templates them: every field a
// string, and "" for a path that doesn't exist on that call (measured in the
// HOL-171 spike).
const SERVER = 'holodeck-adam'

function setUp() {
  const sent: LiveActivityEvent[] = []
  let id = 0
  const reporter = createChannelActivityReporter({
    send: (event) => sent.push(event),
    newEventId: () => `event-${++id}`,
    now: () => new Date('2026-09-24T12:00:00.000Z'),
  })
  const hook = (kind: string, fields: Record<string, string> = {}) =>
    reporter.handleHookCall({ kind, sessionId: 's1', promptId: 'p1', agentId: '', agentType: '', ...fields })
  const holodeckTool = (toolUseId: string, tool: string, taskId: string, fields: Record<string, string> = {}) =>
    hook('tool_started', { toolName: `mcp__${SERVER}__${tool}`, toolUseId, taskId, mcpServer: SERVER, holodeckServer: SERVER, ...fields })
  const nativeTool = (toolUseId: string, toolName: string, fields: Record<string, string> = {}) =>
    hook('tool_started', { toolName, toolUseId, taskId: '', mcpServer: '', holodeckServer: SERVER, ...fields })
  const succeeded = (toolUseId: string, toolName: string, fields: Record<string, string> = {}) =>
    hook('tool_succeeded', { toolName, toolUseId, durationMs: '42', ...fields })
  return { reporter, sent, hook, holodeckTool, nativeTool, succeeded }
}

describe('channel activity reporter', () => {
  it("links create_task's result to its own hook and moves the line's context (plan section 8.6)", () => {
    const { reporter, sent, hook, holodeckTool, nativeTool, succeeded } = setUp()

    hook('turn_started')
    holodeckTool('toolu_create', 'create_task', '')
    reporter.observeCreatedTask('toolu_create', { content: [{ type: 'text', text: '{"id":"cmnewtask0000000000000001","taskId":"TES-7"}' }] })
    succeeded('toolu_create', `mcp__${SERVER}__create_task`)
    nativeTool('toolu_bash', 'Bash')
    succeeded('toolu_bash', 'Bash')
    hook('turn_stopped')

    const [runStarted, createStarted, createFinished, bashStarted, bashFinished, runEnded] = sent
    assert.equal(runStarted?.kind, 'run_started')
    assert.equal(runStarted?.runId, 's1:p1')
    assert.equal(createStarted?.taskId, undefined)
    assert.deepEqual([createFinished?.taskId, createFinished?.taskDisplayId], ['cmnewtask0000000000000001', 'TES-7'])
    assert.equal(bashStarted?.contextTaskId, 'cmnewtask0000000000000001')
    assert.equal(bashStarted?.taskId, undefined)
    assert.equal(bashFinished?.durationMs, 42)
    assert.deepEqual([runEnded?.kind, runEnded?.outcome, runEnded?.contextTaskId], ['run_ended', 'success', 'cmnewtask0000000000000001'])
    assert.deepEqual(
      sent.map((event) => event.seq),
      [1, 2, 3, 4, 5, 6],
    )
  })

  it('keeps background subagents on their own lines, runs and Tasks, whatever prompt_id their events carry', () => {
    const { sent, hook, holodeckTool, succeeded } = setUp()
    const inA = { agentId: 'agentA', agentType: 'general-purpose' }
    const inB = { agentId: 'agentB', agentType: 'general-purpose' }

    hook('turn_started')
    hook('subagent_started', inA)
    hook('subagent_started', inB)
    hook('turn_stopped')
    holodeckTool('toolu_a', 'get_task', 'TES-1', inA)
    holodeckTool('toolu_b', 'add_interaction', 'cmothertask000000000000001', inB)
    // The hand-back of A opens a new turn; B's call finishes under that new prompt_id.
    hook('turn_started', { promptId: 'p2' })
    succeeded('toolu_b', `mcp__${SERVER}__add_interaction`, { ...inB, promptId: 'p2' })
    hook('subagent_stopped', { ...inB, promptId: 'p2' })

    const bFinished = sent.find((event) => event.toolUseId === 'toolu_b' && event.kind === 'tool_finished')
    assert.equal(bFinished?.runId, 's1:agentB')
    assert.equal(bFinished?.lineId, 'agentB')
    assert.equal(bFinished?.lineType, 'general-purpose')
    assert.equal(bFinished?.taskId, 'cmothertask000000000000001')

    const aStarted = sent.find((event) => event.toolUseId === 'toolu_a')
    assert.deepEqual([aStarted?.runId, aStarted?.taskDisplayId, aStarted?.taskId], ['s1:agentA', 'TES-1', undefined])

    // The main turn's Stop and the next prompt never closed the subagents' tools.
    assert.equal(
      sent.some((event) => event.outcome === 'interrupted'),
      false,
    )
    const bEnded = sent.at(-1)
    assert.deepEqual([bEnded?.kind, bEnded?.runId, bEnded?.contextTaskId], ['run_ended', 's1:agentB', 'cmothertask000000000000001'])
  })

  it('links two parallel create_task calls to the right hooks', () => {
    const { reporter, sent, hook, holodeckTool, succeeded } = setUp()
    hook('turn_started')
    holodeckTool('toolu_1', 'create_task', '', { agentId: 'agentA' })
    holodeckTool('toolu_2', 'create_task', '', { agentId: 'agentB' })
    reporter.observeCreatedTask('toolu_2', { content: [{ type: 'text', text: '{"id":"cmtasktwo000000000000000","taskId":"TES-9"}' }] })
    reporter.observeCreatedTask('toolu_1', { content: [{ type: 'text', text: '{"id":"cmtaskone000000000000000","taskId":"TES-8"}' }] })
    succeeded('toolu_1', `mcp__${SERVER}__create_task`, { agentId: 'agentA' })
    succeeded('toolu_2', `mcp__${SERVER}__create_task`, { agentId: 'agentB' })

    const finished = sent.filter((event) => event.kind === 'tool_finished')
    assert.deepEqual(
      finished.map((event) => [event.toolUseId, event.taskDisplayId]),
      [
        ['toolu_1', 'TES-8'],
        ['toolu_2', 'TES-9'],
      ],
    )
  })

  it('closes a tool denied at the prompt, and its turn, when the next prompt arrives', () => {
    const { sent, hook, holodeckTool, nativeTool } = setUp()
    hook('turn_started')
    holodeckTool('toolu_read', 'get_task', 'TES-1')
    nativeTool('toolu_touch', 'Bash')
    hook('tool_awaiting_permission', { toolName: 'Bash' })
    // Denied: no result, no Stop. The user sends another message.
    hook('turn_started', { promptId: 'p2' })

    const awaiting = sent.find((event) => event.kind === 'tool_awaiting_permission')
    assert.equal(awaiting?.toolUseId, 'toolu_touch')
    const closing = sent.slice(-4)
    assert.deepEqual(
      closing.map((event) => [event.kind, event.toolUseId, event.outcome, event.runId]),
      [
        ['tool_finished', 'toolu_read', 'interrupted', 's1:p1'],
        ['tool_finished', 'toolu_touch', 'interrupted', 's1:p1'],
        ['run_ended', undefined, 'interrupted', 's1:p1'],
        ['run_started', undefined, undefined, 's1:p2'],
      ],
    )
  })

  it('treats a message typed during a turn as part of that turn, not a new one', () => {
    const { sent, hook, nativeTool, succeeded } = setUp()
    hook('turn_started')
    nativeTool('toolu_sleep', 'Bash')
    // Measured: the typed message fires UserPromptSubmit at once, with the running turn's prompt_id.
    hook('turn_started')
    succeeded('toolu_sleep', 'Bash', { durationMs: '20085' })
    hook('turn_stopped')

    assert.deepEqual(
      sent.map((event) => [event.kind, event.outcome]),
      [
        ['run_started', undefined],
        ['tool_started', undefined],
        ['tool_finished', 'success'],
        ['run_ended', 'success'],
      ],
    )
  })

  it("ignores a taskId from anything but this Agent's own Holodeck server", () => {
    const { sent, hook, nativeTool } = setUp()
    hook('turn_started')
    nativeTool('toolu_todo', 'TaskUpdate', { taskId: '3' })
    hook('tool_started', { toolName: 'mcp__other__update_task', toolUseId: 'toolu_other', taskId: 'TES-1', mcpServer: 'other', holodeckServer: SERVER })

    assert.equal(
      sent.some((event) => event.taskId || event.taskDisplayId || event.contextTaskId || event.contextTaskDisplayId),
      false,
    )
  })

  it('reports a failed tool as failure, or interrupted when Claude Code says so', () => {
    const { sent, hook, nativeTool } = setUp()
    hook('turn_started')
    nativeTool('toolu_fail', 'Bash')
    hook('tool_failed', { toolName: 'Bash', toolUseId: 'toolu_fail', durationMs: '52', isInterrupt: 'false' })
    nativeTool('toolu_esc', 'Bash')
    hook('tool_failed', { toolName: 'Bash', toolUseId: 'toolu_esc', durationMs: '', isInterrupt: 'true' })

    const finished = sent.filter((event) => event.kind === 'tool_finished')
    assert.deepEqual(
      finished.map((event) => [event.outcome, event.durationMs]),
      [
        ['failure', 52],
        ['interrupted', undefined],
      ],
    )
  })

  it('closes every open line and tool when the session ends', () => {
    const { sent, hook, nativeTool } = setUp()
    hook('turn_started')
    hook('subagent_started', { agentId: 'agentA' })
    nativeTool('toolu_a', 'Bash', { agentId: 'agentA' })
    hook('session_ended')

    assert.deepEqual(
      sent.slice(-4).map((event) => [event.kind, event.lineId, event.outcome]),
      [
        ['tool_finished', 'agentA', 'interrupted'],
        ['run_ended', 'agentA', 'interrupted'],
        ['run_ended', 'main', 'interrupted'],
        ['session_ended', 'main', undefined],
      ],
    )
  })

  it('never throws out of a hook, even for input it does not understand', () => {
    const { reporter, sent } = setUp()
    assert.doesNotThrow(() => reporter.handleHookCall({ kind: 'tool_started' }))
    assert.doesNotThrow(() => reporter.handleHookCall({ kind: 'something_new', sessionId: 's1' }))
    assert.equal(sent.length, 0)
  })
})
