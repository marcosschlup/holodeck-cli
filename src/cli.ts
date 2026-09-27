#!/usr/bin/env node
import { Command } from 'commander'
import { runAgentList, runAgentSetup, runAgentStart } from './agentCommands.js'
import { runChannel } from './channelServer.js'
import { loadClaudeToken, loadServerUrl, setClaudeToken, setServerUrl } from './config.js'
import { runDaemon } from './daemon.js'
import { daemonStatus, ensureDaemonRunning, shutDownDaemon } from './daemonClient.js'
import { runAgentForget, runAgentPause, runLogs } from './headlessCommands.js'
import { runHeadlessMcp } from './headlessMcp.js'
import { listMyAgents } from './holodeckApi.js'
import { loginWithBrowser } from './holodeckLogin.js'
import { loadLoginCredential, saveLoginCredential } from './loginCredential.js'
import { applyUpdate, checkForUpdate, cleanUpOldBinary } from './update.js'
import { maybeNoticeUpdate } from './updateNotice.js'
import { runDoctor } from './doctor.js'
import { runUninstall } from './uninstall.js'
import { readOwnVersion } from './version.js'

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function main(): Promise<void> {
  // Best-effort, every invocation — see its own comment for why this isn't
  // scoped to just the `update` command below.
  cleanUpOldBinary()

  const program = new Command()

  program.name('holodeck').description('Run Holodeck Agents from this machine').version(readOwnVersion())

  program
    .command('update')
    .description('Update to the latest release')
    .option('--check', 'only report whether an update is available, without installing it')
    .action(async (options: { check?: boolean }) => {
      const currentVersion = readOwnVersion()
      try {
        if (options.check) {
          const status = await checkForUpdate(currentVersion)
          console.log(
            status.hasUpdate
              ? `holodeck ${status.latestVersion} is available (you have ${status.currentVersion}). Run: holodeck update`
              : `holodeck ${status.currentVersion} is already the latest version.`,
          )
          return
        }
        const result = await applyUpdate(currentVersion)
        if (!result.updated) {
          console.log(`holodeck ${currentVersion} is already the latest version.`)
          return
        }
        console.log(`Updated to holodeck ${result.version}.`)
        console.log("A `channel run` session already open keeps running the old version until it's restarted (e.g. run `holodeck agent start` again).")
      } catch (error) {
        console.log(errorMessage(error))
        process.exitCode = 1
      }
    })

  program
    .command('login')
    .description('Sign in to Holodeck in your browser — one login covers every Agent you own')
    .action(async () => {
      await maybeNoticeUpdate(readOwnVersion())
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

  // The MCP server of a background Agent's run (HOL-131): Claude Code spawns
  // it over stdio from the config the daemon writes. Never typed by a person.
  const headless = program.command('headless', { hidden: true }).description('Internal: background Agent machinery')

  headless
    .command('mcp')
    .description("A background run's Holodeck MCP server — Claude Code spawns this itself over stdio")
    .argument('<agentId>', "the Agent's id")
    .action(async (agentId: string) => {
      try {
        await runHeadlessMcp(agentId, readOwnVersion())
      } catch (error) {
        process.stderr.write(`${errorMessage(error)}\n`)
        process.exitCode = 1
      }
    })

  // The daemon itself (daemon.ts): the one background process that keeps this
  // machine's background Agents working. `agent setup`/`agent start` start it
  // when needed; these are for looking at it or stopping it by hand.
  program
    .command('start')
    .description('Start the background process that runs your background Agents')
    .option('--foreground', 'stay attached to this terminal instead of detaching')
    .action(async (options: { foreground?: boolean }) => {
      const existing = await daemonStatus()
      if (existing) {
        console.log(`Already running (pid ${existing.pid}).`)
        return
      }
      if (options.foreground) {
        console.log('Running in the foreground. Press Ctrl+C to stop.')
        await runDaemon()
        return
      }
      const started = await ensureDaemonRunning()
      console.log(started ? `Started (pid ${started.pid}).` : "It was started but isn't answering yet; check `holodeck status` shortly.")
    })

  program
    .command('stop')
    .description('Stop the background process; tasks your background Agents are working on end and are reported as failed')
    .action(async () => {
      console.log((await shutDownDaemon()) ? 'Stopped.' : "It wasn't running.")
    })

  program
    .command('status')
    .description('Report whether the background process is running')
    .action(async () => {
      const status = await daemonStatus()
      if (!status) {
        console.log("Not running. Your background Agents aren't taking work; run `holodeck agent start`.")
        return
      }
      console.log(`Running (pid ${status.pid}, up ${Math.round(status.uptimeMs / 1000)}s, ${status.personaCount} background Agent(s)).`)
    })

  program
    .command('logs')
    .description('What a background Agent worked on: its latest runs, newest first')
    .option('--limit <count>', 'how many runs to show', (value) => Number.parseInt(value, 10))
    .option('--verbose', "also show exit codes and where each run's full output is")
    .action(async (options: { limit?: number; verbose?: boolean }) => {
      await runLogs(options)
    })

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
    .description('Put one of your Agents to work (arguments after -- go to Claude Code)')
    .argument('[claudeArguments...]', 'extra arguments for Claude Code, after --')
    .option('--verbose', 'also show the underlying command')
    .action(async (claudeArguments: string[], options: { verbose?: boolean }) => {
      await runAgentStart(claudeArguments, options)
    })

  agent
    .command('list')
    .description('The Agents set up in this folder, and the ones working in the background on this machine')
    .action(async () => {
      await runAgentList()
    })

  agent
    .command('pause')
    .description('Stop a background Agent from taking new tasks, without removing it')
    .action(async () => {
      await runAgentPause()
    })

  // `unpause` from HOL-127's command set: the same as `agent start`.
  agent
    .command('unpause', { hidden: true })
    .description('Same as agent start')
    .action(async () => {
      await runAgentStart([])
    })

  agent
    .command('forget')
    .description('Stop a background Agent from working on this machine at all')
    .action(async () => {
      await runAgentForget()
    })

  const config = program.command('config').description('Manage this machine-wide connection settings')

  config
    .command('set-server')
    .description('Set the Holodeck server URL this machine signs in to')
    .argument('<url>', 'e.g. http://localhost:3000, or a self-hosted deployment URL')
    .action((url: string) => {
      setServerUrl(url)
      console.log(`Server URL set to ${url}.`)
    })

  config
    .command('set-claude-token')
    .description(
      "Set the Claude OAuth token background Agents' runs use (from `claude setup-token`); without it they use this machine's own Claude Code login",
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
      console.log(`Claude token: ${loadClaudeToken() ? 'set' : "not set (runs use this machine's Claude Code login)"}`)
      const login = loadLoginCredential()
      console.log(login ? `Signed in (OAuth) to ${login.serverUrl}` : 'Signed in (OAuth): no. Run `holodeck login` to sign in.')
    })

  program
    .command('doctor')
    .description('Check this machine for common problems (holodeck/claude on PATH, signed in, version) — diagnosis only, fixes nothing itself')
    .action(() => {
      runDoctor()
    })

  program
    .command('uninstall')
    .description('Remove the holodeck binary and its PATH entry from this machine')
    .action(async () => {
      await runUninstall()
    })

  // A "common commands" block like `git --help` shows above its full list.
  program.addHelpText(
    'after',
    `
Common commands:
  holodeck login                   Sign in to Holodeck in your browser
  holodeck update [--check]        Update to the latest release
  holodeck agent setup             Prepare one of your Agents to work in this folder
  holodeck agent start             Put an Agent to work
  holodeck agent list              Your Agents here and in the background
  holodeck agent pause             Stop a background Agent taking new tasks
  holodeck logs                    What a background Agent worked on`,
  )

  await program.parseAsync()
}
