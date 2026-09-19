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

Defaults to the hosted Holodeck, `https://api.holodeck-tracker.com`. Only
needed if you self-host:

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

```bash
npm install
npm run dev -- <command>   # run the CLI directly with tsx, no build step
npm run check               # lint + typecheck
npm run build                # compile to dist/, then `npm start -- <command>` or `node dist/cli.js <command>`
```

## Packaging a standalone build

`npm run build:sea` bundles the CLI (esbuild) and packages it as a Node
[Single Executable Application](https://nodejs.org/api/single-executable-applications.html)
via `scripts/build-sea.mjs` — a single native binary at
`dist-sea/holodeck[.exe]` that needs no Node install on the machine that
runs it. Built and verified on Windows; the macOS/Linux code-signing
steps follow Node's own docs but haven't been run on real hardware yet
(no CI matrix for this yet, PLAN.md 9).

`npm run release -- [patch|minor|major]` (default `patch`) does a full
release in one step: bumps the version (`npm version`, which also
commits and tags), builds the SEA binary, pushes the commit + tag, and
publishes it as a GitHub Release via `gh release create`. Requires a
clean working tree, a configured `git remote`, and the `gh` CLI
installed and authenticated (`gh auth login`) — fails fast with a clear
message if any of those aren't met.

`holodeck --version` reads from `package.json` normally (dev, `npm run build`); a SEA build gets its version baked in at bundle time instead, since there's no `package.json` next to the binary to read at runtime.

### Installing the binary — running `holodeck` from anywhere

There's no installer yet — building only produces the file at
`dist-sea/holodeck[.exe]`, it doesn't put it on your `PATH`. Until it
does, `holodeck` isn't a recognized command; move (or copy) the binary
into a folder your `PATH` already includes, once per machine:

**Windows (PowerShell):**

```powershell
mkdir "$env:LOCALAPPDATA\Holodeck" -Force
Copy-Item .\dist-sea\holodeck.exe "$env:LOCALAPPDATA\Holodeck\holodeck.exe"
[Environment]::SetEnvironmentVariable("Path", "$env:Path;$env:LOCALAPPDATA\Holodeck", "User")
```

Open a new terminal afterwards (`PATH` changes don't reach already-open
ones). Windows resolves `holodeck` to `holodeck.exe` on its own
(`PATHEXT`), no need to type the extension.

**macOS / Linux:**

```bash
mkdir -p ~/.local/bin
cp ./dist-sea/holodeck ~/.local/bin/holodeck
```

`~/.local/bin` is on `PATH` by default on most recent distros; if
`holodeck --version` isn't found afterwards, add it yourself:

```bash
export PATH="$HOME/.local/bin:$PATH"   # add to ~/.bashrc or ~/.zshrc to persist
```

**macOS only, first run after downloading (not building locally):** a
binary downloaded through a browser (e.g. from a GitHub Release) gets
quarantined by Gatekeeper, which blocks it as "from an unidentified
developer" the first time. `build-sea.mjs` already ad-hoc-signs the
binary, but that doesn't clear the quarantine flag itself — either
right-click the file → Open → confirm once, or:

```bash
xattr -d com.apple.quarantine ~/.local/bin/holodeck
```

A real installer (one command that copies itself into place and sets up
`PATH`) is a natural next step once this is used by more than the two of
us, not built yet.
