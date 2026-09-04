# Agent Connector

The `holodeck` CLI — lets a [Holodeck](https://github.com) Agent run as a
`connector`: a long-running local process that keeps an Agent's identity
connected, runs a real Claude Agent SDK session for it, and reacts to
what happens in Holodeck, instead of only being driven by a
human-started session.

This is a companion project to Holodeck's own `task-manager` repo, not a
package inside it. Full design context (why it exists, the Agent
identity/token model, the health-check and push-channel design, the
sandboxing/permissions model) lives in that repo's `PLAN.md`, section 9
("Agent Connector"), until this repo grows enough of its own conventions
to stand on its own.

## Status

The daemon, local IPC channel, token persistence, the live `/agent/events`
connection (online/offline status, graceful disconnect), and a real
Claude Agent SDK session per persona are all working — a registered
persona actually runs, connects to Holodeck's own MCP tools, and checks
for assigned work when it connects or on `holodeck restart`. **Not built
yet**: `path add`/`path set` (adding/changing a persona's working
directory live), and tier 2/3 native OS-level sandboxing (today's
`canUseTool` policy is software-only — see PLAN.md 9).

## Quickstart

### 1. Create the Agent in Holodeck

1. Sign in to Holodeck and open **Manage your agents** → **Create
   agent**.
2. Pick **connector** as the connection type (not `session`) — that's
   what makes it eligible to run through Agent Connector at all.
3. Fill in a name and, optionally, a persona/instructions.
4. Holodeck shows the Agent's token **once**, right after creation. Copy
   it now — it's the last time you'll see it; if you lose it, revoke the
   Agent and create a new one, or ask a project owner to regenerate it.
5. Open the Project you want this Agent to work in → **Add member** →
   pick it under **Your agent** → **Add agent**. An Agent isn't usable in
   a Project until it's explicitly added here, even if you own both.

### 2. Set up Anthropic auth (one time per machine)

Agent Connector runs a persona's Claude session unattended, so it can't
use the normal interactive browser login. It authenticates with a
long-lived OAuth token instead, tied to your Claude Pro/Max/Team/
Enterprise subscription (not per-token API billing).

This needs the Claude Code CLI installed on this machine — if you don't
have it yet:

```powershell
# Windows PowerShell
irm https://claude.ai/install.ps1 | iex
```

(macOS/Linux/WSL: `curl -fsSL https://claude.ai/install.sh | bash`. Other
options — Homebrew, WinGet, npm, Linux package managers — are in
[Claude Code's own install docs](https://code.claude.com/docs/en/setup).)
Verify it worked with `claude --version`.

Then generate the token:

```bash
claude setup-token
```

This opens a browser once for you to approve access, then prints a token
to your terminal — it isn't saved anywhere by that command, so copy it
before it scrolls away. Then hand it to Agent Connector:

```bash
holodeck config set-claude-token <token>
```

One token covers every persona registered on this machine.
(`ANTHROPIC_API_KEY` support, as an alternative to a Claude subscription,
is planned but not built yet.)

If a `CLAUDE_CODE_OAUTH_TOKEN` environment variable is already set in
whatever environment starts the daemon (a persistent machine-level
variable, a systemd unit, Docker, etc.), it's used instead of the config
value — but a plain `export` in a terminal won't reach it: the daemon
runs detached and only inherits the environment of whoever started it at
that moment, not of a shell that exports something afterward. `config
set-claude-token` is the reliable path for everyone else.

### 3. Point Agent Connector at your Holodeck server

Defaults to `http://localhost:3000` (a local/self-hosted instance). Only
needed if yours is somewhere else:

```bash
holodeck config set-server https://your-holodeck-instance.example.com
```

### 4. Register the Agent

```bash
holodeck register
```

An interactive wizard — no flags to remember:

1. **Agent token** — validated against Holodeck immediately; a bad token
   (or wrong `config set-server`) fails right here.
2. **Model** — Agent Connector opens a brief throwaway session just to
   ask Claude which models this account can use, then lets you pick one
   from that live list. If Claude auth isn't set up yet (step 2 above),
   this is where you'll find out, with a clear message telling you what
   to run first.
3. **Working directory** — defaults to wherever you run the command
   (`.`), resolved to an absolute path automatically.

Registering starts the local daemon if it isn't already running, and the
persona's session comes up immediately — it checks Holodeck for any
Tasks assigned to it as soon as it connects. Add `--watch` to stay
attached and watch its log live right after (Ctrl+C to detach — the
persona itself keeps running).

### 5. Check on it

```bash
holodeck list
```

Shows every registered persona and its live connection status
(`connected` / `connecting` / `reconnecting` / `paused`). The same status
shows as an online/offline dot next to the Agent in the Holodeck Web UI.

```bash
holodeck logs <persona>
```

Shows that persona's session activity, summarized for reading (tool
calls, replies, results — internal bookkeeping like rate-limit pings is
hidden). Add `--follow` to keep streaming new lines, `--raw` for the
original JSONL instead, or `--clear` to erase that persona's log without
touching its registration.

## Everyday commands

```
holodeck register [--watch]                Register a new Agent (interactive wizard)
holodeck list                              List every registered persona (alias: ps)
holodeck status                            Is the local daemon running
holodeck restart <persona>                 Restart one persona's Claude session
holodeck logs <persona> [--follow] [--raw] [--clear]   Show/stream/clear a persona's session activity

holodeck agent pause <persona>             Disconnect, keep the token
holodeck agent unpause <persona>           Reconnect, no token needed again
holodeck agent forget <persona>            Remove entirely (needs the token again to bring back)

holodeck start [--foreground]              Start the local daemon
holodeck stop                              Shut the daemon down (every persona disconnects, none are forgotten)

holodeck config set-server <url>           Which Holodeck server to talk to (machine-wide)
holodeck config set-claude-token <token>   Claude OAuth token every persona authenticates with
holodeck config show                       Show the current settings

holodeck path add <persona> <path>         Not built yet
holodeck path set <persona> <path>         Not built yet
```

## Development

No packaged binary yet (single-executable packaging is deliberately
deferred until the design stabilizes, PLAN.md 9) — run it from source:

```bash
npm install
npm run dev -- <command>   # run the CLI directly with tsx, no build step
npm run check               # lint + typecheck
npm run build                # compile to dist/, then `npm start -- <command>` or `node dist/cli.js <command>`
```

`holodeck --version` reads straight from `package.json` — no separate literal to keep in sync. Bump it with npm's own `npm version patch|minor|major` (updates `package.json` and creates a matching git commit + tag) when a change is worth calling a new version. No CI/publish pipeline yet, so that's a manual, deliberate step for now — revisit once real distribution (PLAN.md 9's deferred SEA packaging) exists and commit-driven automation (e.g. semantic-release) is actually worth the setup.
