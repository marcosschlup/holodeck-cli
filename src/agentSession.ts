import { query, type HookCallback, type ModelInfo, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { loadClaudeToken, loadServerUrl } from './config.js'
import { CONNECTOR_USER_AGENT } from './holodeck.js'
import type { PersonaRecord } from './store.js'

// A push-based async iterable — the SDK's streaming `prompt` input, so a
// persona's session can be handed new turns over its lifetime instead of
// being a single one-shot `query()` call. Same pull-queue shape as the
// backend's own lib/asyncQueue.ts, kept local here rather than shared
// across the two otherwise-unrelated repos.
class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private pendingResolve: ((result: IteratorResult<SDKUserMessage>) => void) | null = null
  private closed = false

  push(message: SDKUserMessage): void {
    if (this.closed) {
      return
    }
    if (this.pendingResolve) {
      const resolve = this.pendingResolve
      this.pendingResolve = null
      resolve({ value: message, done: false })
    } else {
      this.items.push(message)
    }
  }

  close(): void {
    this.closed = true
    if (this.pendingResolve) {
      const resolve = this.pendingResolve
      this.pendingResolve = null
      resolve({ value: undefined, done: true })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.items.length > 0) {
          // SAFETY: length check above guarantees shift() returns an
          // element, not undefined-for-empty-array.
          return Promise.resolve({ value: this.items.shift()!, done: false })
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise((resolve) => {
          this.pendingResolve = resolve
        })
      },
    }
  }
}

function userTurn(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
  }
}

// Tier 1 of PLAN.md 9's three-tier sandboxing plan: "cwd + a policy we
// write — works everywhere, weakest guarantee (still just software
// policy)". There's no human present to click "allow" for a
// connector-driven persona, so this is the actual authorization decision,
// not a formality:
// - Holodeck's own MCP tools (`mcp__holodeck__*`, or whatever this
//   persona's MCP server is namespaced as) are always allowed — that's
//   the entire point of a connector persona.
// - File tools (Read/Edit/Write/Grep/Glob) are allowed — the SDK already
//   refuses reads outside the session's working directories in every
//   permission mode (its own `cwd`/`additionalDirectories` boundary), so
//   this doesn't need to duplicate that check.
// - `Bash` (arbitrary shell) is denied for now — the one tool this
//   software-only tier genuinely can't bound safely (a command string can
//   do anything the OS user can). Enabling it is exactly what tier 2/3
//   native sandboxing (a follow-up task once this lands) is for, not a
//   gap to paper over here.
//
// A `PreToolUse` hook, not `canUseTool` (HOL-62):
// `canUseTool` is only consulted when the CLI's own internal risk
// classifier, under `permissionMode: 'default'`, decides a call is
// "dangerous" enough to ask about — confirmed against the real SDK bundle
// (`vGe`'s own `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning acknowledges
// exactly this class of bypass, e.g. `bypassPermissions` mode or bare
// `allowedTools` entries; a benign-looking Bash call being silently
// classified as "not dangerous" and never reaching the classifier's own
// ask-gate at all is the same shape of gap, just not one the SDK's own
// warning happens to cover). A read-only-looking command like `pwd && ls
// -la` never reached this session's own `canUseTool` at all and ran
// unchecked — Bash was never actually blocked by tier 1's own documented
// policy. `PreToolUse` hooks run strictly before that dangerous/not
// classification (confirmed: "Denials that resolve before canUseTool
// runs — PreToolUse hook denies... are not covered" by the SDK's own
// `tool_denied` event doc) — the SDK's own recommended fix for exactly
// this shadowing problem. Replaces `canUseTool` entirely rather than
// running alongside it: a hook denial short-circuits before `canUseTool`
// would even run, so keeping both would mean two allow-lists that could
// silently drift apart over time for zero added protection.
function buildToolPolicyHook(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return { continue: true }
    }
    const { tool_name: toolName } = input
    if (toolName.startsWith('mcp__') || ['Read', 'Edit', 'Write', 'Grep', 'Glob'].includes(toolName)) {
      return { continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }
    }
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `"${toolName}" isn't allowed yet — Agent Connector's tier-1 sandboxing (PLAN.md 9, HOL-57/HOL-62) only allows Holodeck's own tools and file read/edit tools until native OS-level sandboxing (tier 2/3) exists.`,
      },
    }
  }
}

// Spun up just to ask "what models exist", then torn down — used by the
// `register` wizard (cli.ts) to offer a live choice instead of a
// hardcoded/guessed list. No `mcpServers`/`canUseTool` needed: this
// session never does real work, its `prompt` queue is never pushed to,
// so it never spends a model turn — `supportedModels()` is control-plane
// metadata, not a completion. Throws if `claudeToken` is missing/invalid,
// same as a real session would; the caller (cli.ts) turns that into the
// "run `claude setup-token` first" guidance.
export async function listAvailableModels(claudeToken: string | undefined): Promise<ModelInfo[]> {
  const inbox = new MessageQueue()
  const session = query({
    prompt: inbox,
    options: { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: claudeToken } },
  })
  try {
    return await session.supportedModels()
  } finally {
    inbox.close()
    session.close()
  }
}

export interface PersonaSession {
  // Pushes a new turn into the live session — the MVP trigger this
  // starts with (HOL-57): once right when the session connects, and
  // again on an explicit `holodeck restart <persona>`.
  send: (text: string) => void
  onMessage: (listener: (message: SDKMessage) => void) => void
  close: () => Promise<void>
}

// One persona's live Claude Agent SDK session, kept alive for as long as
// the persona is connected (PLAN.md 9: "Owns one live Query per persona
// it manages, kept alive in-process"). `query()` is called exactly once
// here — the `Query` it returns IS the long-lived handle; there's no
// separate client object to construct (see PLAN.md 9's 2026-09-03
// correction: no `ClaudeSDKClient` in the real SDK).
export function startPersonaSession(record: PersonaRecord): PersonaSession {
  const inbox = new MessageQueue()
  const listeners = new Set<(message: SDKMessage) => void>()

  // The daemon's own ambient env wins if present — it only gets there if
  // the user set it somewhere that actually reaches the daemon process
  // (a persistent machine-level env var, a systemd unit, Docker, etc.),
  // never from an ad-hoc `export` in whatever terminal happens to be open
  // right now: the daemon is detached (spawn .. { detached: true },
  // cli.ts) and only ever inherits the environment of whoever started it,
  // not of a shell that exports something afterward. `config
  // set-claude-token` (config.ts) is the reliable path for everyone else.
  const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? loadClaudeToken()
  const session: Query = query({
    prompt: inbox,
    options: {
      cwd: record.cwd,
      model: record.model,
      hooks: { PreToolUse: [{ hooks: [buildToolPolicyHook()] }] },
      // Tier 2 (PLAN.md 9) — independent layer from the `hooks.PreToolUse`
      // tier-1 policy above, which still hard-denies `Bash` regardless of
      // sandbox state, so there's no security regression either way this
      // resolves. On native Windows today, the SDK's sandbox is
      // feature-gated off ("Sandbox required but unavailable... feature
      // gate off") — with `failIfUnavailable`'s own default (`true`), that
      // would make every session on Windows fail to *start at all*.
      // `failIfUnavailable: false` degrades gracefully instead: sandboxed
      // where the platform already supports it (macOS/Linux/WSL2,
      // unaffected by the Windows gate), silently unsandboxed elsewhere for
      // now — safe because tier 1 is the actual gate on Windows in the
      // interim, not this option.
      //
      // **Decision: wait for Anthropic's own native Windows sandbox to
      // ship, rather than build a Codex CLI wrapper now** (HOL-64's own
      // investigation: real, but a genuine medium-sized, undocumented-
      // wire-protocol integration, not a thin one). Left `enabled: true`
      // deliberately — the moment Anthropic's feature gate opens, this
      // starts sandboxing on Windows with zero further changes here;
      // nothing to remember to flip. Revisit building the Codex-based
      // wrapper (PLAN.md 9, HOL-64) only if this wait turns out to take too
      // long, or the decision changes.
      sandbox: { enabled: true, autoAllowBashIfSandboxed: true, failIfUnavailable: false },
      // Replaces the subprocess environment entirely (doesn't merge with
      // process.env — confirmed against the SDK's own .d.ts), so every
      // inherited variable this subprocess still needs (PATH, HOME, ...)
      // has to be spread in explicitly here, not just the credential.
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: claudeToken },
      // Without this, the persona has no way to reach Holodeck at all: the
      // session would authenticate fine, but ToolSearch would turn up
      // nothing for list_projects/list_tasks. Same Bearer-token auth
      // `resolveAgentIdentity` (holodeck.ts) already uses for the one-off
      // get_my_context call at `register` time.
      // `alwaysLoad: true` because this is the core, always-relevant tool
      // set for a connector persona, not something worth deferring behind
      // tool search the way an incidental MCP server would be.
      mcpServers: {
        holodeck: {
          type: 'http',
          url: new URL('/mcp', loadServerUrl()).toString(),
          headers: { Authorization: `Bearer ${record.token}`, 'User-Agent': CONNECTOR_USER_AGENT },
          alwaysLoad: true,
        },
      },
    },
  })

  void (async () => {
    for await (const message of session) {
      for (const listener of listeners) {
        listener(message)
      }
    }
  })()

  return {
    send: (text: string) => inbox.push(userTurn(text)),
    onMessage: (listener) => {
      listeners.add(listener)
    },
    close: async () => {
      inbox.close()
      session.close()
    },
  }
}
