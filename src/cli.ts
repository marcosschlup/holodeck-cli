#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { isSea } from 'node:sea'
import { fileURLToPath } from 'node:url'
import { input, password, select } from '@inquirer/prompts'
import { Command } from 'commander'
import { listAvailableModels } from './agentSession.js'
import { runAgentList, runAgentSetup, runAgentStart } from './agentCommands.js'
import { runChannel } from './channelServer.js'
import { loadClaudeToken, loadServerUrl, setClaudeToken, setServerUrl } from './config.js'
import { runDaemon } from './daemon.js'
import { resolveAgentIdentity } from './holodeck.js'
import { listMyAgents } from './holodeckApi.js'
import { loginWithBrowser } from './holodeckLogin.js'
import { loadLoginCredential, saveLoginCredential } from './loginCredential.js'
import { sendIpcRequest, type IpcResponse } from './ipc.js'
import { formatLogContent, formatLogLine } from './logFormat.js'
import { deleteLog, followLog, logFileExists, readLog } from './personaLog.js'
import { loadPersonas } from './store.js'

// A detached background daemon needs to actually run this same script a
// second time as its own process — there's no separate daemon binary to
// point at (see `ensureDaemonRunning`'s respawn below for how it re-
// invokes itself, source script or SEA binary alike). `--__daemon` is
// that second invocation's own signal to become the daemon instead of
// parsing normal CLI args; it's deliberately not registered as a real
// Commander command; `holodeck --help` should never advertise it as
// something a user runs directly.
//
// Wrapped in an async IIFE rather than top-level `await` — Node's SEA
// packaging (`scripts/build-sea.mjs`) currently only supports a
// CommonJS main script (ESM entry support is still landing upstream,
// https://github.com/nodejs/node/pull/61813), and top-level await is an
// ESM-only syntax feature esbuild refuses to emit for a CJS bundle. This
// shape works unchanged under `tsx` (dev), `tsc` (plain build), and the
// esbuild CJS bundle alike.
void (async () => {
  if (process.argv.includes('--__daemon')) {
    await runDaemon()
  } else {
    await main()
  }
})()

// `package.json`'s own version, single source of truth for `holodeck
// --version` rather than a hardcoded literal that could drift out of sync.
// `../package.json` resolves consistently whether this runs as `src/cli.ts`
// under tsx (dev) or as the built `dist/cli.js` (`npm run build`) — both
// sit one directory below the package root. A SEA binary has no such
// file next to it (the whole point is a single self-contained
// executable), so `scripts/build-sea.mjs` bakes the version in at bundle
// time via esbuild's `define`, replacing `__HOLODECK_SEA_VERSION__` with
// a real string literal — falls through to the file read whenever that
// replacement never happened (dev, and the plain `npm run build`).
declare const __HOLODECK_SEA_VERSION__: string | undefined

function readOwnVersion(): string {
  if (typeof __HOLODECK_SEA_VERSION__ !== 'undefined') {
    return __HOLODECK_SEA_VERSION__
  }
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version: string }
  return packageJson.version
}

type StatusOk = Extract<IpcResponse, { op: 'status' }>
type RegisterOk = Extract<IpcResponse, { op: 'register' }>
type PauseOk = Extract<IpcResponse, { op: 'pause' }>
type UnpauseOk = Extract<IpcResponse, { op: 'unpause' }>
type RestartOk = Extract<IpcResponse, { op: 'restart' }>
type ForgetOk = Extract<IpcResponse, { op: 'forget' }>
type ListOk = Extract<IpcResponse, { op: 'list' }>
type ShutdownOk = Extract<IpcResponse, { op: 'shutdown' }>

// register/pause/status/etc each carry different fields on success, so
// `response.ok` alone isn't enough for TypeScript (or a reader) to know
// which fields are actually there — one small checker per op, rather than
// one generic helper, keeps the narrowing simple and easy to follow.
function isStatusOk(response: IpcResponse | null): response is StatusOk {
  return response !== null && response.ok && response.op === 'status'
}
function isRegisterOk(response: IpcResponse | null): response is RegisterOk {
  return response !== null && response.ok && response.op === 'register'
}
function isPauseOk(response: IpcResponse | null): response is PauseOk {
  return response !== null && response.ok && response.op === 'pause'
}
function isUnpauseOk(response: IpcResponse | null): response is UnpauseOk {
  return response !== null && response.ok && response.op === 'unpause'
}
function isRestartOk(response: IpcResponse | null): response is RestartOk {
  return response !== null && response.ok && response.op === 'restart'
}
function isForgetOk(response: IpcResponse | null): response is ForgetOk {
  return response !== null && response.ok && response.op === 'forget'
}
function isListOk(response: IpcResponse | null): response is ListOk {
  return response !== null && response.ok && response.op === 'list'
}
function isShutdownOk(response: IpcResponse | null): response is ShutdownOk {
  return response !== null && response.ok && response.op === 'shutdown'
}

// Starts the daemon if it isn't already reachable, detached from this
// terminal — shared by `start` (explicit) and `register` (implicit, so
// the first command a user ever runs already works). Resolves to the
// daemon's status once it's confirmed up, or `null` if it never answered.
async function ensureDaemonRunning(): Promise<StatusOk | null> {
  const existing = await sendIpcRequest({ op: 'status' })
  if (isStatusOk(existing)) {
    return existing
  }

  // Re-invokes this same script as a detached child with `--__daemon`
  // (handled above, before Commander ever runs) — `process.execPath` +
  // `process.argv[1]` is Node's own documented way to respawn "this
  // script, the way it's currently running" regardless of whether that's
  // `tsx src/cli.ts` in dev or `node dist/cli.js` once built. A SEA
  // binary breaks that assumption: there's no separate script file, so
  // `process.execPath` already points at the one self-contained
  // executable and `process.argv[1]` is just the first real CLI
  // argument, not a script path — `isSea()` (Node's own way to ask "am I
  // running as a single executable application") tells us which shape
  // to respawn with. The extra `'ipc'` stdio slot is the same
  // parent/child messaging channel `fork()` sets up automatically —
  // gives the child a way to report "I'm actually listening now" the
  // instant it's true (runDaemon's own `process.send?.('ready')`),
  // rather than polling on a fixed schedule: a failed connection attempt
  // resolves near-instantly, so naive retries would burn through their
  // whole budget in a fraction of a second, and any fixed delay is still
  // just a guess at timing.
  const respawnArgs = isSea()
    ? ['--__daemon']
    : [...process.execArgv, process.argv[1] as string, '--__daemon']
  const child = spawn(process.execPath, respawnArgs, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })

  const becameReady = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 10_000)
    child.once('message', (message: unknown) => {
      if (message === 'ready') {
        clearTimeout(timeout)
        resolve(true)
      }
    })
    child.once('exit', () => {
      clearTimeout(timeout)
      resolve(false)
    })
  })
  // The 'exit' branch above means the child died before ever sending
  // 'ready' (e.g. it lost a race for the IPC address right after a
  // previous daemon released it) — its IPC channel is already torn down
  // by the time we get here, and disconnecting it again throws.
  if (child.connected) {
    child.disconnect()
  }
  child.unref()

  if (!becameReady) {
    return null
  }
  const started = await sendIpcRequest({ op: 'status' })
  return isStatusOk(started) ? started : null
}

// Shared by `logs <persona> --follow` and `register --watch` — prints
// whatever that persona has logged so far, then keeps printing new lines
// as they're appended, until `signal` aborts (both callers wire that to
// SIGINT). `raw` shows the untouched JSONL instead of the formatted
// summary (logFormat.ts).
async function watchPersonaLog(persona: string, raw: boolean, signal: AbortSignal): Promise<void> {
  const existing = readLog(persona)
  const formatted = raw ? existing.trimEnd() : formatLogContent(existing)
  if (formatted !== '') {
    console.log(formatted)
  }
  await followLog(
    persona,
    (line) => {
      const output = raw ? line : formatLogLine(line)
      if (output !== null) {
        console.log(output)
      }
    },
    signal,
  )
}

// No command takes an Agent's name as an argument (HOL-132) - choosing one is
// always a selector. For the commands that operate on personas registered
// with the local daemon, the choices are the locally registered personas.
async function pickPersona(message: string): Promise<string | undefined> {
  const personas = loadPersonas()
  if (personas.length === 0) {
    console.log('No personas registered.')
    return undefined
  }
  return select({ message, choices: personas.map((p) => ({ name: p.name, value: p.name })) })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function main(): Promise<void> {
  // Skeleton only for `path add`/`path set`/`logs`/`restart` — those need
  // the Agent SDK integration (not part of this epic yet). Every other
  // command is wired to the real daemon (HOL-52/53/54).
  function notImplemented(command: string): void {
    console.log(`"${command}" isn't implemented yet.`)
  }

  const program = new Command()

  program.name('holodeck').description('Run Holodeck Agents from this machine').version(readOwnVersion())

  program
    .command('login')
    .description('Sign in to Holodeck in your browser — one login covers every Agent you own')
    .action(async () => {
      const serverUrl = loadServerUrl()
      let tokens
      try {
        tokens = await loginWithBrowser(serverUrl)
      } catch (error) {
        console.log(`Sign-in failed: ${errorMessage(error)}`)
        return
      }
      saveLoginCredential({ serverUrl, ...tokens })
      // Proves the login works against Holodeck's CLI API, not merely that
      // a token came back - the same API every setup command relies on.
      try {
        const agents = await listMyAgents()
        console.log(`Signed in to ${serverUrl}. You own ${agents.length} Agent(s).`)
      } catch (error) {
        console.log(`Signed in, but Holodeck's CLI API didn't accept the login: ${errorMessage(error)}`)
        return
      }
      console.log('Next: run `holodeck agent setup` in a project folder to get one of your Agents ready there.')
    })

  // The Channel machinery (HOL-122/130): a process Claude Code itself spawns
  // per session, over stdio, from the config `agent setup` writes. An
  // implementation detail the person never types (HOL-135), so hidden from
  // --help - but `channel run` must keep working (existing config files call
  // it), and `channel add` stays as a hidden alias of `agent setup` for anyone
  // following older instructions.
  const channel = program.command('channel', { hidden: true }).description('Internal: the per-session Agent process')

  channel
    .command('add')
    .description('Alias of `agent setup`')
    .option('--verbose', 'also show the underlying command')
    .action(async (options: { verbose?: boolean }) => {
      await runAgentSetup(options)
    })

  channel
    .command('run')
    .description("The Channel's own MCP server — Claude Code spawns this itself over stdio, don't run it by hand")
    .argument('<agentId>', "the Agent's id, as written into its .holodeck config by `channel add`")
    .action(async (agentId: string) => {
      // Claude Code reads this process's stdout as the MCP protocol: failures
      // go to stderr, and the exit code is what shows up as the server
      // `failed` in `/mcp`.
      try {
        await runChannel(agentId, readOwnVersion())
      } catch (error) {
        process.stderr.write(`${errorMessage(error)}
`)
        process.exitCode = 1
      }
    })

  program
    .command('register')
    .description('Register a new Agent with the local daemon — walks you through it')
    .option('--watch', "stay attached and watch this persona's log live after registering, until Ctrl+C")
    .action(async (options: { watch?: boolean }) => {
      // Step 1: the Holodeck token — resolved immediately so a bad token
      // (or wrong `config set-server`) fails fast, before asking anything
      // else.
      const token = await password({ message: 'Agent token (from Holodeck\'s "Manage your agents"):' })
      const serverUrl = loadServerUrl()
      let identity
      try {
        identity = await resolveAgentIdentity(serverUrl, token)
      } catch {
        console.log(
          `Couldn't validate that token against ${serverUrl}. Check the token, or \`holodeck config set-server\` if that's the wrong server.`,
        )
        return
      }
      console.log(`Found "${identity.agentName}" (owned by ${identity.ownerName}).`)

      // Step 2: which Claude model — a throwaway session just to ask
      // (agentSession.ts's listAvailableModels), so the choices are
      // whatever this account actually has, not a hardcoded/guessable
      // list. Same real Claude auth a persona's own session will need, so
      // this doubles as an early check that it's actually set up —
      // failing here beats failing silently on every future `register`/
      // `agent unpause`.
      console.log('Looking up available Claude models...')
      const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? loadClaudeToken()
      let models
      try {
        models = await listAvailableModels(claudeToken)
      } catch {
        console.log(
          'Could not reach Claude. Run `claude setup-token`, then `holodeck config set-claude-token <token>`, before registering a persona.',
        )
        return
      }
      const model = await select({
        message: 'Which model should this persona use?',
        choices: models.map((m) => ({ name: m.displayName, value: m.value, description: m.description })),
      })

      // Step 3: working directory, defaulting to wherever this command is
      // being run from.
      const cwdInput = await input({ message: 'Working directory for this persona:', default: '.' })
      // Resolved here, against this process's own cwd — the daemon this
      // is sent to is a detached background process with no reason to
      // share (or even know) whatever directory the user happened to run
      // `register` from, so a relative path (most commonly just `.`,
      // probably the common case) has to become absolute before it
      // crosses the IPC boundary, not after.
      const cwd = resolvePath(cwdInput)

      const daemon = await ensureDaemonRunning()
      if (daemon === null) {
        console.log("Couldn't start the daemon.")
        return
      }

      // A longer timeout than sendIpcRequest's 2s default — this op also
      // starts the persona's Claude Agent SDK session (HOL-57), and a
      // first-time subprocess spawn can genuinely take a few seconds.
      const response = await sendIpcRequest({ op: 'register', name: identity.agentName, token, cwd, model }, 15_000)
      if (!isRegisterOk(response)) {
        console.log(response?.ok === false ? `Failed to register: ${response.error}` : 'Registration failed.')
        return
      }
      console.log(`Registered "${identity.agentName}" (owned by ${identity.ownerName}).`)

      if (options.watch) {
        console.log('Watching its log — Ctrl+C to stop.\n')
        const controller = new AbortController()
        process.on('SIGINT', () => controller.abort())
        await watchPersonaLog(identity.agentName, false, controller.signal)
      }
    })

  program
    .command('list')
    .alias('ps')
    .description('List every persona the local daemon is currently holding')
    .action(async () => {
      const response = await sendIpcRequest({ op: 'list' })
      if (!isListOk(response)) {
        console.log('Daemon is not running.')
        return
      }
      if (response.personas.length === 0) {
        console.log('No personas registered.')
        return
      }
      for (const persona of response.personas) {
        console.log(`${persona.name}  ${persona.cwd ?? ''}  ${persona.status}`.trimEnd())
      }
    })

  program
    .command('stop')
    .description('Shut the local daemon down entirely — every persona disconnects, none are forgotten')
    .action(async () => {
      const response = await sendIpcRequest({ op: 'shutdown' })
      console.log(isShutdownOk(response) ? 'Daemon stopped.' : 'Daemon is not running.')
    })

  program
    .command('restart')
    .description("Restart one persona's Claude session, without touching any other persona or its connection")
    .argument('<persona>', "the Agent's name, as shown in `holodeck list`")
    .action(async (persona: string) => {
      const response = await sendIpcRequest({ op: 'restart', name: persona }, 15_000)
      if (isRestartOk(response)) {
        console.log(response.found ? `Restarted "${persona}".` : `No persona named "${persona}" was registered.`)
      } else {
        console.log('Daemon is not running.')
      }
    })

  program
    .command('status')
    .description('Report whether the local daemon is running')
    .action(async () => {
      const response = await sendIpcRequest({ op: 'status' })
      if (!isStatusOk(response)) {
        console.log('Daemon is not running.')
        return
      }
      const uptimeSeconds = Math.round(response.uptimeMs / 1000)
      console.log(
        `Daemon is running (pid ${response.pid}, up ${uptimeSeconds}s, ${response.personaCount} persona(s) registered).`,
      )
    })

  program
    .command('logs')
    .description("Show a persona's own session activity log, formatted for humans by default")
    .option('--follow', 'keep streaming new log lines')
    .option('--raw', 'show the original JSONL instead of the human-readable summary')
    .option('--clear', "erase a persona's log without touching its registration")
    .action(async (options: { follow?: boolean; raw?: boolean; clear?: boolean }) => {
      const persona = await pickPersona("Which persona's log?")
      if (!persona) {
        return
      }
      if (options.clear) {
        deleteLog(persona)
        console.log(`Cleared "${persona}"'s log.`)
        return
      }
      if (!logFileExists(persona)) {
        console.log(`No log yet for "${persona}" — it hasn't produced any session activity.`)
        return
      }
      if (options.follow) {
        const controller = new AbortController()
        process.on('SIGINT', () => controller.abort())
        await watchPersonaLog(persona, Boolean(options.raw), controller.signal)
        return
      }
      const content = readLog(persona)
      console.log(options.raw ? content.trimEnd() : formatLogContent(content))
    })

  program
    .command('start')
    .description('Start the local daemon explicitly')
    .option('--foreground', 'stay attached to this terminal instead of detaching')
    .action(async (options: { foreground?: boolean }) => {
      const existing = await sendIpcRequest({ op: 'status' })
      if (isStatusOk(existing)) {
        console.log(`Daemon is already running (pid ${existing.pid}).`)
        return
      }

      if (options.foreground) {
        console.log('Starting daemon in the foreground. Press Ctrl+C to stop it.')
        await runDaemon()
        return
      }

      const started = await ensureDaemonRunning()
      if (started !== null) {
        console.log(`Daemon started (pid ${started.pid}).`)
      } else {
        console.log("Daemon process was spawned, but isn't answering yet — check `holodeck status` shortly.")
      }
    })

  // A separate group from the bare `start`/`stop` above — those are about
  // the daemon process itself; these are about one persona within it.
  // Folding "reconnect a persona" into `start <persona>` would read as
  // ambiguous with "start the daemon" — this group exists specifically so
  // no command name has to mean two different things depending on whether
  // an argument happens to be there.
  const agent = program.command('agent').description('Set up and start your Agents on this machine')

  agent
    .command('setup')
    .description('Prepare one of your Agents to work in this folder')
    .option('--verbose', 'also show the underlying command')
    .action(async (options: { verbose?: boolean }) => {
      await runAgentSetup(options)
    })

  agent
    .command('start')
    .description('Put one of the Agents set up in this folder to work (arguments after -- go to Claude Code)')
    .argument('[claudeArguments...]', 'extra arguments for Claude Code, after --')
    .option('--verbose', 'also show the underlying command')
    .action(async (claudeArguments: string[], options: { verbose?: boolean }) => {
      await runAgentStart(claudeArguments, options)
    })

  agent
    .command('list')
    .description('The Agents set up in this folder')
    .action(async () => {
      await runAgentList()
    })

  agent
    .command('pause')
    .description('Disconnect a persona without forgetting it — the token stays registered')
    .action(async () => {
      const persona = await pickPersona('Which persona should be paused?')
      if (!persona) {
        return
      }
      const response = await sendIpcRequest({ op: 'pause', name: persona })
      if (isPauseOk(response)) {
        console.log(
          response.found
            ? `Paused "${persona}". Run \`holodeck agent unpause ${persona}\` to reconnect it.`
            : `No persona named "${persona}" was registered.`,
        )
      } else {
        console.log('Daemon is not running.')
      }
    })

  agent
    .command('unpause')
    .description('Reconnect a paused persona, without needing its token again')
    .action(async () => {
      const persona = await pickPersona('Which persona should be unpaused?')
      if (!persona) {
        return
      }
      const daemon = await ensureDaemonRunning()
      if (daemon === null) {
        console.log("Couldn't start the daemon.")
        return
      }
      const response = await sendIpcRequest({ op: 'unpause', name: persona }, 15_000)
      if (isUnpauseOk(response)) {
        console.log(
          response.found
            ? `Unpaused "${persona}".`
            : `No persona named "${persona}" was registered. Use \`holodeck register <token>\` first.`,
        )
      } else {
        console.log('Daemon is not running.')
      }
    })

  agent
    .command('forget')
    .description("Remove a persona entirely — you'll need its token again to bring it back")
    .action(async () => {
      const persona = await pickPersona('Which persona should be forgotten?')
      if (!persona) {
        return
      }
      const response = await sendIpcRequest({ op: 'forget', name: persona })
      if (isForgetOk(response)) {
        console.log(response.removed ? `Forgot "${persona}".` : `No persona named "${persona}" was registered.`)
      } else {
        console.log('Daemon is not running.')
      }
    })

  const config = program.command('config').description('Manage this machine-wide connection settings')

  config
    .command('set-server')
    .description('Set the Holodeck server URL every persona on this machine connects to')
    .argument('<url>', 'e.g. http://localhost:3000, or a self-hosted deployment URL')
    .action((url: string) => {
      setServerUrl(url)
      console.log(`Server URL set to ${url}.`)
    })

  config
    .command('set-claude-token')
    .description(
      'Set the Claude OAuth token every persona session on this machine authenticates with (from `claude setup-token`)',
    )
    .argument('<token>', 'a CLAUDE_CODE_OAUTH_TOKEN, e.g. from running `claude setup-token`')
    .action((token: string) => {
      setClaudeToken(token)
      console.log('Claude token set.')
    })

  config
    .command('show')
    .description('Show the current machine-wide settings')
    .action(() => {
      console.log(`Server: ${loadServerUrl()}`)
      console.log(`Claude token: ${loadClaudeToken() ? 'set' : 'not set'}`)
      const login = loadLoginCredential()
      console.log(
        login ? `Signed in (OAuth) to ${login.serverUrl}` : 'Signed in (OAuth): no. Run `holodeck login` to sign in.',
      )
    })

  const path = program.command('path').description("Manage a persona's working directory")

  path
    .command('add')
    .description("Add a directory to a persona's already-running session, live, no restart")
    .argument('<persona>', "the Agent's name, as shown in `holodeck list`")
    .argument('<path>', 'directory to add')
    .action((persona: string, dirPath: string) => {
      notImplemented(`path add ${persona} ${dirPath}`)
    })

  path
    .command('set')
    .description("Change a persona's primary working directory — always restarts that persona's session")
    .argument('<persona>', "the Agent's name, as shown in `holodeck list`")
    .argument('<path>', 'new primary working directory')
    .action((persona: string, dirPath: string) => {
      notImplemented(`path set ${persona} ${dirPath}`)
    })

  // Commander's own command list (above) is alphabetical/registration-order
  // and flat — fine as a full reference, but doesn't tell a first-time user
  // which handful of commands they'll actually reach for. This is the same
  // "common commands" block `git --help` shows above its own full list,
  // added via `addHelpText` rather than reordering/hiding anything in the
  // real command list itself (`configureHelp({ visibleCommands })` would do
  // that, but every command here is genuinely one someone might run).
  program.addHelpText(
    'after',
    `
Common commands:
  holodeck login                   Sign in to Holodeck in your browser
  holodeck agent setup             Prepare one of your Agents to work in this folder
  holodeck agent start             Put an Agent to work
  holodeck agent list              The Agents set up in this folder
  holodeck register                Register a new Agent (interactive)
  holodeck list                    List every registered Agent
  holodeck agent pause             Pause a registered Agent (keeps its token)
  holodeck agent unpause           Resume a paused Agent
  holodeck status                 Check whether the daemon is running`,
  )

  await program.parseAsync()
}
