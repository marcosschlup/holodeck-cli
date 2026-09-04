// Turns the raw JSONL a persona's log is stored as (personaLog.ts) into a
// short, human-readable line per entry — or drops the entry entirely when
// it's internal bookkeeping (heartbeat-style `thinking_tokens` deltas,
// rate-limit pings, ...) rather than something a person watching would
// care about. `holodeck logs --raw` always has the untouched original —
// this is a display convenience, not the only copy of the data.
//
// Considered `claude-pretty-printer` (npm) instead of writing this:
// rejected after testing it against real captured messages — it throws
// on a `system/init` message missing a field it assumes is always
// present (no optional chaining anywhere in its formatter), and doesn't
// filter the exact noisy types (`rate_limit_event`, `thinking_tokens`)
// this was meant to hide in the first place, so it wouldn't have saved
// the filtering work anyway. Written defensively here on purpose:
// nothing below should ever throw on a message shape it doesn't
// recognize, since a future SDK version's own message shapes aren't
// pinned tightly (agent-connector's own dependency floor is wide).

interface ContentBlock {
  type?: string
  text?: string
  name?: string
  input?: unknown
  thinking?: string
  content?: unknown
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

function summarizeValue(value: unknown, max = 120): string {
  if (typeof value === 'string') {
    return truncate(value, max)
  }
  try {
    return truncate(JSON.stringify(value), max)
  } catch {
    return String(value)
  }
}

// A tool_result's `content` is itself an array of content blocks (usually
// just `{type: 'text', text: ...}`) — pull the text out rather than
// showing the wrapper shape.
function formatToolResultContent(content: unknown): string {
  if (Array.isArray(content)) {
    const texts = content
      .map((block) => (block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : null))
      .filter((text): text is string => text !== null)
    if (texts.length > 0) {
      return summarizeValue(texts.join(' '))
    }
  }
  return summarizeValue(content)
}

// One parsed JSONL entry (a raw `SDKMessage`, structurally) → one display
// line, or `null` to hide it. `entry` is untyped on purpose — this reads
// real SDK output that may not match this CLI's pinned `.d.ts` exactly
// (an older log file from a previous SDK version, a message shape this
// code doesn't model yet), so every field access below is optional.
export function formatLogEntry(entry: Record<string, unknown>): string | null {
  const type = entry.type

  if (type === 'rate_limit_event') {
    return null
  }

  if (type === 'system') {
    if (entry.subtype === 'init') {
      const mcpServers = Array.isArray(entry.mcp_servers) ? (entry.mcp_servers as { name?: string; status?: string }[]) : []
      const mcp = mcpServers.length > 0 ? mcpServers.map((s) => `${s.name ?? '?'} (${s.status ?? '?'})`).join(', ') : 'none'
      return `● connected — model ${entry.model ?? '?'}, cwd ${entry.cwd ?? '?'}, mcp: ${mcp}`
    }
    if (entry.subtype === 'permission_denied') {
      return `⛔ denied "${entry.tool_name ?? '?'}"`
    }
    // Every other system subtype (thinking_tokens deltas, status pings,
    // hook lifecycle, ...) is internal bookkeeping, not conversation
    // content — hidden by default.
    return null
  }

  if (type === 'assistant' || type === 'user') {
    const content = (entry.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) {
      return null
    }
    const lines: string[] = []
    for (const block of content as ContentBlock[]) {
      if (block?.type === 'text' && block.text) {
        // A blank line before the agent's own visible reply — sets it
        // apart from the mechanical tool-call/result lines above it,
        // which is what a person watching actually wants to read.
        lines.push('', truncate(block.text, 500))
      } else if (block?.type === 'thinking' && block.thinking) {
        lines.push(`(thinking) ${truncate(block.thinking, 200)}`)
      } else if (block?.type === 'tool_use') {
        lines.push(`→ ${block.name ?? '?'}(${summarizeValue(block.input)})`)
      } else if (block?.type === 'tool_result') {
        lines.push(`← ${formatToolResultContent(block.content)}`)
      }
    }
    if (lines.length === 0) {
      return null
    }
    const prefix = entry.is_api_error_message ? '⚠ ' : ''
    return `${prefix}${lines.join('\n')}`
  }

  if (type === 'result') {
    // Deliberately not showing `total_cost_usd` here — confirmed live
    // (Marcos, 2026-09-03) it reads as a real dollar charge but isn't
    // one for a subscription-authenticated session (`apiKeySource:
    // "none"`): the SDK's own docs call it "an estimate, not a billing
    // statement," what actually happens is real usage is metered against
    // the subscription's rolling quota (`rate_limit_event`'s
    // `unifiedWindows`), not billed per token. Showing a number that
    // looks like money but isn't is worse than not showing one.
    const seconds = typeof entry.duration_ms === 'number' ? (entry.duration_ms / 1000).toFixed(1) : '?'
    // Trailing blank line — marks the end of this turn, so the next
    // `● connected` (a restart, or the next persona event) doesn't run
    // straight into it.
    if (entry.is_error) {
      return `✗ error (${seconds}s): ${summarizeValue(entry.result ?? 'unknown error', 300)}\n`
    }
    return `✓ done (${seconds}s)\n`
  }

  return null
}

// Parses one raw JSONL line and formats it — an unparseable line (a
// half-written line mid-append, or genuinely not JSON) is shown as-is
// rather than silently dropped, so a real problem stays visible instead
// of vanishing.
export function formatLogLine(rawLine: string): string | null {
  try {
    return formatLogEntry(JSON.parse(rawLine) as Record<string, unknown>)
  } catch {
    return rawLine
  }
}

export function formatLogContent(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(formatLogLine)
    .filter((line): line is string => line !== null)
    .join('\n')
}
