import { CONNECTOR_USER_AGENT } from './holodeck.js'
import type { LiveActivityEvent } from './liveActivityEvents.js'

// Batched delivery to `POST /agent/activity/v2` (docs/agent-live-activity-v2.md,
// section 6.4). Never makes a hook wait on the network: events are queued
// and flushed on a timer, oldest first.
//
// Only a network error, a 5xx, a 401 or a 429 retries a batch. Anything else
// the backend answers is final for those events, including a per-event
// rejection or a 4xx for the whole batch: they're logged and dropped, so one
// event the backend will never accept can't block the rest of the session.

const MAX_BATCH = 100
const MAX_QUEUE = 1000
const MAX_BACKOFF_MS = 30_000

export interface LiveActivityDelivery {
  enqueue(event: LiveActivityEvent): void
  flush(): Promise<void>
  // Stops the timer and makes one last attempt, bounded by `timeoutMs`, so a
  // session's final events aren't lost when the process exits.
  stop(timeoutMs?: number): Promise<void>
}

interface DeliveryOptions {
  serverUrl: string
  getToken: () => Promise<string>
  log: (message: string) => void
  intervalMs?: number
  fetchImpl?: typeof fetch
  now?: () => number
}

interface EventResult {
  eventId: string | null
  status: 'accepted' | 'duplicate' | 'rejected'
  reason?: string
}

function isRetryable(status: number): boolean {
  return status >= 500 || status === 401 || status === 429
}

export function createLiveActivityDelivery({
  serverUrl,
  getToken,
  log,
  intervalMs = 500,
  fetchImpl = fetch,
  now = Date.now,
}: DeliveryOptions): LiveActivityDelivery {
  const queue: LiveActivityEvent[] = []
  let sending: Promise<void> | undefined
  let failures = 0
  let retryAt = 0
  let droppedForOverflow = false

  function enqueue(event: LiveActivityEvent): void {
    queue.push(event)
    if (queue.length > MAX_QUEUE) {
      queue.shift()
      if (!droppedForOverflow) {
        log('live activity: queue is full; dropping the oldest events until the backend catches up')
        droppedForOverflow = true
      }
    }
  }

  async function sendBatch(): Promise<void> {
    const batch = queue.slice(0, MAX_BATCH)
    let response: Response
    try {
      response = await fetchImpl(new URL('/agent/activity/v2', serverUrl), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await getToken()}`,
          'content-type': 'application/json',
          'user-agent': CONNECTOR_USER_AGENT,
        },
        body: JSON.stringify({ events: batch }),
      })
    } catch (error) {
      scheduleRetry(String(error))
      return
    }

    if (isRetryable(response.status)) {
      scheduleRetry(`HTTP ${response.status}`)
      return
    }

    if (failures > 0) {
      log('live activity: delivery to the backend recovered')
    }
    failures = 0
    retryAt = 0
    queue.splice(0, batch.length)
    droppedForOverflow = false

    if (!response.ok) {
      log(`live activity: backend refused a batch of ${batch.length} events (HTTP ${response.status}); dropped`)
      return
    }
    const body = (await response.json().catch(() => undefined)) as { results?: EventResult[] } | undefined
    for (const result of body?.results ?? []) {
      if (result.status === 'rejected') {
        log(`live activity: event ${result.eventId ?? '?'} rejected (${result.reason ?? 'no reason'}); dropped`)
      }
    }
  }

  function scheduleRetry(detail: string): void {
    if (failures === 0) {
      log(`live activity: couldn't deliver to ${serverUrl}/agent/activity/v2 (${detail}); will keep retrying`)
    }
    failures += 1
    retryAt = now() + Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** failures)
  }

  async function flush(): Promise<void> {
    if (sending) {
      return sending
    }
    if (queue.length === 0 || now() < retryAt) {
      return
    }
    sending = sendBatch().finally(() => {
      sending = undefined
    })
    return sending
  }

  const timer = setInterval(() => void flush(), intervalMs)

  async function stop(timeoutMs = 1000): Promise<void> {
    clearInterval(timer)
    retryAt = 0
    let timeout: NodeJS.Timeout | undefined
    await Promise.race([flush(), new Promise((resolve) => (timeout = setTimeout(resolve, timeoutMs)))])
    clearTimeout(timeout)
  }

  return { enqueue, flush, stop }
}
