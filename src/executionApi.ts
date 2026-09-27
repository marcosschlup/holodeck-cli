import { CONNECTOR_USER_AGENT } from './holodeck.js'

// Client for Holodeck's Headless execution queue (HOL-129, backend
// `/agent/executions/*`, docs/headless-execution-queue.md in task-manager):
// the daemon claims one Task at a time for an Agent, sends a heartbeat while
// the run goes, and reports how it ended. Every call uses the Agent's own
// token (`headless` purpose).

export type ExecutionTrigger = 'assignment' | 'mention' | 'block_resolved'

export interface ClaimedExecution {
  id: string
  trigger: ExecutionTrigger
  enqueuedAt: string
  startedAt: string
  task: { id: string; displayId: string; title: string; projectId: string }
  // For a `mention` run (HOL-147): the notes on this Task that tagged the Agent
  // and it hadn't read, oldest first. Holodeck marks them read at the claim, so
  // they reach the run only through its prompt.
  mentions?: { text: string; authorName: string | null; authorHandle: string | null; at: string }[]
}

// The entry isn't running any more on the server (finished, or failed as
// `lost` after a long silence): the run it belongs to must stop.
export type ExecutionState = 'running' | 'not_running'

async function post(serverUrl: string, token: string, pathname: string, body?: unknown): Promise<Response> {
  return fetch(new URL(pathname, serverUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': CONNECTOR_USER_AGENT,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function failure(response: Response, what: string): Promise<Error> {
  const payload = (await response.json().catch(() => ({}))) as { error?: string }
  return new Error(`${what}: Holodeck answered ${response.status}${payload.error ? ` (${payload.error})` : ''}`)
}

// The next Task to work on, or null when there's none (or the Agent already
// runs as many as it may).
export async function claimExecution(serverUrl: string, token: string): Promise<ClaimedExecution | null> {
  const response = await post(serverUrl, token, '/agent/executions/claim')
  if (!response.ok) {
    throw await failure(response, 'claim failed')
  }
  return ((await response.json()) as { execution: ClaimedExecution | null }).execution
}

export async function sendExecutionHeartbeat(serverUrl: string, token: string, entryId: string): Promise<ExecutionState> {
  const response = await post(serverUrl, token, `/agent/executions/${encodeURIComponent(entryId)}/heartbeat`)
  if (response.status === 409) {
    return 'not_running'
  }
  if (!response.ok) {
    throw await failure(response, 'heartbeat failed')
  }
  return 'running'
}

export async function reportExecutionEnd(
  serverUrl: string,
  token: string,
  entryId: string,
  outcome: { success: boolean; reason?: string },
): Promise<'recorded' | 'not_running'> {
  const response = await post(serverUrl, token, `/agent/executions/${encodeURIComponent(entryId)}/complete`, outcome)
  if (response.status === 409) {
    return 'not_running'
  }
  if (!response.ok) {
    throw await failure(response, 'reporting the end failed')
  }
  return 'recorded'
}
