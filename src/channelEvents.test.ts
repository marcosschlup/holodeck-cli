import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { describeChannelEvent } from './channelEvents.js'

// A notice lands in the middle of a person's session, read by a model that
// knows nothing else about it. One that needs no action has to say so, and
// none may send the model after a tool it has no reason to call (HOL-236).

describe('added to a project', () => {
  it('names the Project, asks for nothing and says what the Agent will be told', () => {
    const notice = describeChannelEvent({ type: 'agent_added_to_project', projectId: 'p1', data: { projectName: 'Customer Portal' } })

    assert.match(notice.content, /^You were added to the Holodeck project "Customer Portal" \(id p1\)\./)
    assert.match(notice.content, /nothing to do right now/)
    assert.match(notice.content, /assigned to you or someone mentions you/)
    assert.deepEqual(notice.meta, { event: 'agent_added_to_project', project_id: 'p1' })
  })

  it('still reads well from a Holodeck that sends no name', () => {
    const notice = describeChannelEvent({ type: 'agent_added_to_project', projectId: 'p1' })

    assert.match(notice.content, /^You were added to a Holodeck project \(id p1\)\./)
  })
})

describe('notices that need no setting up', () => {
  it("don't mention subscriptions", () => {
    const notices = [
      describeChannelEvent({ type: 'agent_added_to_project', projectId: 'p1' }),
      describeChannelEvent({ type: 'agent_removed_from_project', projectId: 'p1' }),
      describeChannelEvent({ type: 'agent_instructions_updated' }),
    ]

    for (const notice of notices) {
      assert.doesNotMatch(notice.content, /subscri/i)
    }
  })
})
