import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createLiveActivityDelivery } from './liveActivityDelivery.js'
import type { LiveActivityEvent } from './liveActivityEvents.js'

function event(n: number): LiveActivityEvent {
  return {
    eventId: `event-${n}`,
    seq: n,
    sessionId: 's1',
    runId: 's1:p1',
    mode: 'channel',
    lineId: 'main',
    at: '2026-09-24T12:00:00.000Z',
    kind: 'tool_started',
    toolName: 'Bash',
    toolUseId: `toolu_${n}`,
  }
}

function setUp(respond: (batch: LiveActivityEvent[]) => Response | Promise<Response>) {
  const batches: LiveActivityEvent[][] = []
  const logs: string[] = []
  const clock = { now: 0 }
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const batch = (JSON.parse(String(init?.body)) as { events: LiveActivityEvent[] }).events
    batches.push(batch)
    return respond(batch)
  }) as typeof fetch
  const delivery = createLiveActivityDelivery({
    serverUrl: 'https://api.example.test',
    getToken: async () => 'token',
    log: (message) => logs.push(message),
    // Large enough that only explicit flush() calls send anything.
    intervalMs: 60_000,
    fetchImpl,
    now: () => clock.now,
  })
  return { delivery, batches, logs, clock }
}

function results(batch: LiveActivityEvent[], rejectedIds: string[] = []): Response {
  return Response.json({
    results: batch.map((sent) =>
      rejectedIds.includes(sent.eventId) ? { eventId: sent.eventId, status: 'rejected', reason: 'kind: invalid' } : { eventId: sent.eventId, status: 'accepted' },
    ),
  })
}

describe('live activity delivery', () => {
  it('sends queued events in order, at most 100 per batch', async () => {
    const { delivery, batches } = setUp((batch) => results(batch))
    for (let n = 1; n <= 150; n++) {
      delivery.enqueue(event(n))
    }

    await delivery.flush()
    await delivery.flush()
    await delivery.stop()

    assert.deepEqual(
      batches.map((batch) => batch.length),
      [100, 50],
    )
    assert.equal(batches[1]?.[0]?.eventId, 'event-101')
  })

  it('drops a rejected event after logging it, without blocking the next ones', async () => {
    const { delivery, batches, logs } = setUp((batch) => results(batch, ['event-1']))
    delivery.enqueue(event(1))
    delivery.enqueue(event(2))
    await delivery.flush()
    delivery.enqueue(event(3))
    await delivery.flush()
    await delivery.stop()

    assert.deepEqual(
      batches.map((batch) => batch.map((sent) => sent.eventId)),
      [['event-1', 'event-2'], ['event-3']],
    )
    assert.equal(logs.filter((line) => line.includes('event-1 rejected')).length, 1)
  })

  it('keeps a batch for retry on a 5xx or network error, and drops one the backend refuses outright', async () => {
    const statuses = [503, 400]
    let networkErrorFirst = true
    const { delivery, batches, logs, clock } = setUp((batch) => {
      if (networkErrorFirst) {
        networkErrorFirst = false
        throw new TypeError('fetch failed')
      }
      const status = statuses.shift()
      return status ? new Response(null, { status }) : results(batch)
    })
    delivery.enqueue(event(1))

    await delivery.flush() // network error: kept
    await delivery.flush() // still backing off: nothing sent
    clock.now += 10 * 60_000
    await delivery.flush() // 503: kept
    clock.now += 10 * 60_000
    await delivery.flush() // 400: dropped
    await delivery.flush() // nothing left to send
    await delivery.stop()

    assert.deepEqual(
      batches.map((batch) => batch.map((sent) => sent.eventId)),
      [['event-1'], ['event-1'], ['event-1']],
    )
    assert.ok(logs.some((line) => line.includes('will keep retrying')))
    assert.ok(logs.some((line) => line.includes('refused a batch')))
  })

  it('drops the oldest events once the queue is full', async () => {
    const { delivery, batches, logs } = setUp((batch) => results(batch))
    for (let n = 1; n <= 1001; n++) {
      delivery.enqueue(event(n))
    }
    await delivery.flush()
    await delivery.stop()

    assert.equal(batches[0]?.[0]?.eventId, 'event-2')
    assert.equal(logs.filter((line) => line.includes('queue is full')).length, 1)
  })
})
