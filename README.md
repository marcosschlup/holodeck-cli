# Holodeck CLI

The `holodeck` CLI puts one of your [Holodeck](https://github.com) Agents to
work from a project folder on your own machine, as a real Claude Code
session that stays reachable: it gets pushed a notification the moment
something relevant happens in Holodeck (a Task assigned to it, a mention,
a block answered), instead of only reacting when someone manually starts
a session.

This is a companion project to Holodeck's own main repo (`task-manager`),
not a package inside it. Full design context (connection modes, identity
model, health checks, the push channel) lives in that repo's `PLAN.md`,
section 9 ("Channel and headless").

## Before you start

You need:

- **A Holodeck account**, with at least one Agent of type **Channel**
  (created from Holodeck's Web UI: **Manage your agents → Create agent**,
  connection type **Channel**) registered into the Project you want it to
  work in (that Project's **Add member** dialog, under **Your agent**).
- **[Claude Code](https://code.claude.com/docs/en/setup) installed and
  already signed in** on this machine — the CLI starts a real `claude`
  session, so whatever gets you a working `claude` session on its own
  (subscription login, or an API key) is enough. Verify with
  `claude --version`.

## Quickstart

### 1. Sign in

```bash
holodeck login
```

Opens your browser once, against Holodeck's own OAuth. One login on this
machine covers every Agent you own — you won't be asked again until it
expires (30 days).

By default this talks to the hosted Holodeck,
`https://api.holodeck-tracker.com`. Only needed if you self-host:

```bash
holodeck config set-server https://your-holodeck-instance.example.com
```

### 2. Set up an Agent in this folder

```bash
holodeck agent setup
```

Lists your Channel Agents and asks which one to prepare here. Writes one
small config file under `.holodeck/` (safe to add to `.gitignore` — it
names your own Agent, so a teammate shouldn't get it from a shared
repository) and offers to start it right away.

### 3. Start it

```bash
holodeck agent start
```

Opens a real Claude Code session for that Agent, with its model and
effort (set in Holodeck) already applied. While it's running, it reacts
live to what happens in its Projects — no need to keep asking it to check.
Anything after `--` goes straight to Claude Code:

```bash
holodeck agent start -- --resume
```

Ctrl+C ends the session the same way it would in Claude Code directly.

### 4. Check what's set up

```bash
holodeck agent list
```

The Agents set up in this folder, and whether each can still be started
(an Agent removed from Holodeck, or switched to a different connection
type, shows why it can't).

## Everyday commands

```
holodeck login                     Sign in to Holodeck in your browser
holodeck agent setup [--verbose]   Prepare one of your Agents to work in this folder
holodeck agent start [-- ...]      Start an Agent set up in this folder
holodeck agent list                The Agents set up in this folder

holodeck config set-server <url>   Which Holodeck server to talk to (machine-wide)
holodeck config show               Show the current settings
```

`--verbose` on `setup`/`start` also prints the underlying `claude`
command and config file path — useful for troubleshooting, not needed for
everyday use.

## Not built yet

- **Headless Agents** (an Agent that runs a Task in the background
  without a standing session) — planned, not available from this CLI yet.
- **An installer.** Building only produces a binary; see "Packaging a
  standalone build" below for what that involves today.

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
runs it. Useful for a local build to test with; an actual release is
built for every platform in CI, not locally (below).

`npm run release -- [patch|minor|major]` (default `patch`) bumps the
version (`npm version`, which also commits and tags) and pushes the
commit + tag. That push is the trigger:
[`.github/workflows/release.yml`](.github/workflows/release.yml) builds
the binary on every target platform (Windows, macOS x64/arm64, Linux
x64/arm64 — no Windows arm64 yet), smoke-tests each one on its own
native runner, and publishes them all as one GitHub Release with a
combined `SHA256SUMS`. Releasing needs a clean working tree and a
configured `git remote`; it doesn't need the `gh` CLI, or even a
successful local build, on your own machine anymore — the workflow does
its own build from the pushed tag.

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

## License

[Holodeck CLI License 1.0](LICENSE) — you can read, run and audit this
code, including for commercial use, as long as that use is to connect
to the Holodeck service. Modifying it or redistributing it (as source
or as a built binary) isn't permitted.
