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

- **A Holodeck account**, with at least one Agent of type **Channel** or
  **Headless** (created from Holodeck's Web UI: **Manage your agents →
  Create agent**) registered into the Project you want it to work in (that
  Project's **Add member** dialog, under **Your agent**). A Channel Agent is
  a Claude Code session you keep open; a Headless Agent works in the
  background (see "Agents that work in the background" below).
- **[Claude Code](https://code.claude.com/docs/en/setup) installed and
  already signed in** on this machine — the CLI starts a real `claude`
  session, so whatever gets you a working `claude` session on its own
  (subscription login, or an API key) is enough. Verify with
  `claude --version`.

## Quickstart

### 0. Install

**macOS / Linux:**

```bash
curl -fsSL https://app.holodeck-tracker.com/install.sh | sh
```

**Windows (PowerShell):**

```powershell
irm https://app.holodeck-tracker.com/install.ps1 | iex
```

Downloads the right binary for your OS/architecture from the
[latest release](https://github.com/marcosschlup/holodeck-cli/releases),
verifies its checksum, and puts it on your `PATH`. Set
`HOLODECK_VERSION`/`$env:HOLODECK_VERSION` first to install a specific
version instead of the latest one. Once installed, `holodeck update`
(below) is the faster way to update later — re-running either command
above still works too, e.g. if `holodeck` itself is somehow broken.

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
holodeck update [--check]          Update to the latest release
holodeck agent setup [--verbose]   Prepare one of your Agents to work in this folder
holodeck agent start [-- ...]      Start an Agent set up in this folder, or a background one
holodeck agent list                The Agents set up in this folder, and the background ones
holodeck agent pause / forget      Pause or remove a background Agent
holodeck logs                      What a background Agent worked on

holodeck config set-server <url>   Which Holodeck server to talk to (machine-wide)
holodeck config show               Show the current settings

holodeck doctor                    Check this machine for common problems (diagnosis only)
holodeck uninstall                 Remove the holodeck binary and its PATH entry
```

`--verbose` on `setup`/`start` also prints the underlying `claude`
command and config file path — useful for troubleshooting, not needed for
everyday use.

`login`, `agent setup` and `agent start` check once a day whether a newer
release exists, and print a one-line nudge if so (never on `channel
run`, whose stdout is the MCP protocol channel). Silent on any network
failure — this is a courtesy, never something that blocks a command. Set
`HOLODECK_NO_UPDATE_CHECK=1` to skip it entirely (e.g. in a script or CI).

## Agents that work in the background

A **Headless** Agent has no session to keep open. `holodeck agent setup`
asks which folder it works in and how many tasks it may work on at the same
time (1 to 5; the same setting as in Holodeck's Manage Agents page), then a
background process on this machine takes over: whenever a task is assigned
to the Agent, or a block on one of its tasks is resolved, it runs Claude Code
on that task (`claude -p`, the Agent's model and effort from Holodeck) and
reports back when it ends. It keeps working after the terminal closes. After
a reboot it is not running until `holodeck agent start` (or `holodeck start`)
starts it again; tasks assigned meanwhile wait in Holodeck.

- **Where it works.** In a git repository, each task gets its own worktree
  (Claude Code's own, under `.claude/worktrees/`, on a `worktree-...`
  branch), so runs never touch your working copy or each other. A worktree
  with nothing uncommitted is removed when the run ends (and its branch, if
  the run made no commits); one with uncommitted changes is kept for you to
  look at. Add `.claude/worktrees/` to your `.gitignore`. In a folder that
  isn't a git repository it works on one task at a time, in the folder itself.
- **Permissions.** Nobody is there to approve anything, so runs use Claude
  Code's auto permission mode and anything that would still ask is refused.
  Auto mode depends on the model: on one that doesn't support it, Claude Code
  falls back to asking, which means every edit is refused (`holodeck logs`
  says so).
- **When a run fails** (or this machine stops reporting it for 5 minutes),
  Holodeck blocks the task with the reason. Resolving that block runs it
  again.

```
holodeck agent pause               Stop a background Agent taking new tasks (running ones finish)
holodeck agent start               Take work again
holodeck agent forget              Stop it working on this machine at all
holodeck logs [--verbose]          Its latest runs: task, result, duration, cost
holodeck status / stop             The background process itself
holodeck config set-claude-token   A Claude token for its runs (default: this machine's Claude Code login)
```

Its own log (connections, runs starting and ending) is `daemon.log` in the
CLI's data folder.

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

### Using a local build instead of a release

`npm run build:sea`'s output (`dist-sea/holodeck[.exe]`) isn't on your
`PATH` on its own — that's only true of a real release, installed with
the command in "Quickstart" above. To try your own local build instead,
move (or copy) it into the same folder the installer would have used
(`%LOCALAPPDATA%\Holodeck\holodeck.exe` on Windows,
`~/.local/bin/holodeck` on macOS/Linux), overwriting what's there.

## License

[Holodeck CLI License 1.0](LICENSE) — you can read, run and audit this
code, including for commercial use, as long as that use is to connect
to the Holodeck service. Modifying it or redistributing it (as source
or as a built binary) isn't permitted.
