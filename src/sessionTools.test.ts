import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toolsForSession } from './sessionTools.js'

describe('toolsForSession', () => {
  it('marks every tool to load upfront and leaves out the hidden ones', () => {
    const tools = [
      { name: 'get_task', description: 'Reads a Task' },
      { name: 'report_health', description: 'Answered by the CLI' },
      { name: 'create_task', description: 'Creates a Task', _meta: { other: 'kept' } },
    ]

    assert.deepEqual(toolsForSession(tools, new Set(['report_health'])), [
      { name: 'get_task', description: 'Reads a Task', _meta: { 'anthropic/alwaysLoad': true } },
      { name: 'create_task', description: 'Creates a Task', _meta: { other: 'kept', 'anthropic/alwaysLoad': true } },
    ])
  })

  it("doesn't change the tools it was given", () => {
    const tools = [{ name: 'get_task' }]
    toolsForSession(tools, new Set())
    assert.deepEqual(tools, [{ name: 'get_task' }])
  })
})
