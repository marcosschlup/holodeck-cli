import { CONNECTOR_USER_AGENT } from './holodeck.js'

// Shared by agentActivity.ts (Channel, HOL-163) and headlessActivity.ts
// (Headless, HOL-164): once a transport has already reduced its own raw
// source (a hook call, a stream-json line) into an `AgentActivityEvent`,
// getting it to `POST /agent/activity` is identical either way — queue it,
// never make the caller wait on the network, drain on a timer, tolerate the
// backend being down. Kept in its own file rather than duplicated, or
// living in either transport's own file.

const MAX_QUEUE_SIZE = 200
const SEND_INTERVAL_MS = 1000

export interface ActivityDeliveryQueue<T> {
  enqueue(event: T): void
  stop(): void
}

export function createActivityDeliveryQueue<T>(
  serverUrl: string,
  getToken: () => Promise<string>,
  log: (message: string) => void,
): ActivityDeliveryQueue<T> {
  const queue: T[] = []
  function enqueue(event: T): void {
    queue.push(event)
    if (queue.length > MAX_QUEUE_SIZE) {
      queue.shift()
      log('agent activity queue is full; dropped the oldest pending event')
    }
  }

  async function sendOne(event: T): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await fetch(new URL('/agent/activity', serverUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await getToken()}`,
          'content-type': 'application/json',
          'user-agent': CONNECTOR_USER_AGENT,
        },
        body: JSON.stringify(event),
      })
      return { ok: response.ok, detail: `HTTP ${response.status}` }
    } catch (error) {
      return { ok: false, detail: String(error) } // Unreachable backend — the caller retries on the next tick.
    }
  }

  // Sends oldest-first, one at a time, so a run's own events never arrive
  // out of order at the backend. Stops at the first failure rather than
  // skipping past it: the same event is retried next tick instead of being
  // silently lost the moment the backend comes back. Logs only on the
  // FIRST failure of a run of them, and once on recovery, not every tick —
  // a backend down for minutes shouldn't flood the log for no new
  // information.
  let wasFailing = false
  let draining = false
  async function drain(): Promise<void> {
    if (draining) {
      return
    }
    draining = true
    try {
      while (queue.length > 0) {
        const { ok, detail } = await sendOne(queue[0] as T)
        if (!ok) {
          if (!wasFailing) {
            log(`agent activity: couldn't reach ${serverUrl}/agent/activity (${detail}); will keep retrying`)
            wasFailing = true
          }
          break
        }
        if (wasFailing) {
          log('agent activity: delivery to the backend recovered')
          wasFailing = false
        }
        queue.shift()
      }
    } finally {
      draining = false
    }
  }
  const timer = setInterval(() => void drain(), SEND_INTERVAL_MS)

  return { enqueue, stop: () => clearInterval(timer) }
}
