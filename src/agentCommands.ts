import { confirm, select } from '@inquirer/prompts'
import { ACTIVITY_HOOK_TOOL } from './channelServer.js'
import { launchClaude, resolveClaudeExecutable } from './claudeLauncher.js'
import {
  getAgentAccessToken,
  listMyAgents,
  NotLoggedInError,
  SessionExpiredError,
  type AgentSummary,
} from './holodeckApi.js'
import { findChannelConfigs, isMissingFromGitIgnore, isServerNameTaken, writeChannelConfig, type ChannelConfig } from './mcpConfig.js'
import { maybeNoticeUpdate } from './updateNotice.js'
import { readOwnVersion } from './version.js'

// `holodeck agent setup` / `agent start` / `agent list` (HOL-135): the CLI as
// seen from the AGENT's side. The user says "set up Adam" and "start Adam"; what
// that means (today: a Claude Code session with the Agent's Channel; later,
// for background Agents, the daemon: HOL-131) is decided here from the Agent's
// type, which comes from the server. Nothing the person sees should talk about
// "channels", config files or Claude Code flags unless they ask (`--verbose`).
// No Agent name is ever an argument (HOL-132): choosing an Agent is a selector.

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// An Agent's name (e.g. "Claude Desktop") is free text, but a server key ends up
// in the command line Claude Code is started with (`server:<name>`) - an
// untouched space or other punctuation would break it. The exact Agent id still
// travels correctly as `channel run`'s own argument (inside a JSON args array,
// never shell-parsed), so this slug is only ever used for the server key and
// file name, never for resolving the Agent back.
function slugify(agentName: string): string {
  const slug = agentName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'agent' : slug
}

const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY)

interface RunnerSettings {
  model: string | null
  effort: string | null
}

const NO_RUNNER_SETTINGS: RunnerSettings = { model: null, effort: null }

interface ConfiguredAgent {
  config: ChannelConfig
  // The Agent's CURRENT name in Holodeck (the file only has the slug it had
  // when it was set up, which goes stale on a rename), or the file's own
  // name when Holodeck couldn't be asked.
  name: string
  // The Agent's model (HOL-138) and effort (HOL-140) in Holodeck, passed to
  // Claude Code; null when Holodeck couldn't be asked or none is set.
  runner: RunnerSettings
  available: boolean
  problem?: string
}

// What the file itself can tell: `holodeck-adam` -> `adam`.
function nameFromFile(config: ChannelConfig): string {
  return config.serverName.replace(/^holodeck-/, '')
}

// The Agents set up in this folder, each labelled with its current name and
// whether it can still be started. A failure to reach Holodeck falls back to the
// names in the files (and says so); being logged out or expired does not, since
// starting would fail anyway.
async function resolveConfigured(
  configs: ChannelConfig[],
): Promise<{ entries: ConfiguredAgent[]; namesMayBeStale: boolean } | { error: string }> {
  let agents: AgentSummary[]
  try {
    agents = await listMyAgents()
  } catch (error) {
    if (error instanceof NotLoggedInError || error instanceof SessionExpiredError) {
      return { error: error.message }
    }
    return {
      entries: configs.map((config) => ({ config, name: nameFromFile(config), runner: NO_RUNNER_SETTINGS, available: true })),
      namesMayBeStale: true,
    }
  }
  const entries = configs.map((config): ConfiguredAgent => {
    const agent = agents.find((candidate) => candidate.id === config.agentId)
    if (!agent) {
      return { config, name: nameFromFile(config), runner: NO_RUNNER_SETTINGS, available: false, problem: 'no longer available' }
    }
    if (agent.connectionMode !== 'channel' || !canRunVendor(agent)) {
      return { config, name: agent.name, runner: NO_RUNNER_SETTINGS, available: false, problem: 'no longer set up to work this way' }
    }
    return { config, name: agent.name, runner: { model: agent.model, effort: agent.effort }, available: true }
  })
  return { entries, namesMayBeStale: false }
}

// The Agent types `agent setup` knows how to prepare. Background Agents
// (`headless`) join when HOL-131 adds their setup.
const SETUP_MODES: AgentSummary['connectionMode'][] = ['channel']

// The runner `agent start` knows how to launch is Claude Code (HOL-138); an
// Agent of another vendor would need its own launcher.
const canRunVendor = (agent: AgentSummary) => agent.vendor === 'claude'

async function setUpChannelAgent(agent: AgentSummary, verbose: boolean): Promise<ChannelConfig | undefined> {
  const cwd = process.cwd()

  // Ask for a token now, before writing anything: proves this Agent can
  // actually work this way (right type, still exists) instead of leaving a
  // config that only fails once a session starts.
  try {
    await getAgentAccessToken(agent.id, 'channel')
  } catch (error) {
    console.log(`Couldn't get ${agent.name} ready: ${errorMessage(error)}`)
    return undefined
  }

  // One config file per Agent under .holodeck/ (mcpConfig.ts explains why not a
  // shared .mcp.json), so any number of Agents can share a folder. Same Agent
  // again: refresh its file under the name it already has (the Agent may have
  // been renamed since; a second file for the same Agent would start two
  // processes fighting over one connection). Otherwise a new file, with a
  // unique name since two Agents can share a name.
  const existing = findChannelConfigs(cwd).find((config) => config.agentId === agent.id)
  let serverName = existing?.serverName ?? `holodeck-${slugify(agent.name)}`
  if (!existing && isServerNameTaken(cwd, serverName)) {
    serverName = `${serverName}-${agent.id.slice(-6)}`
  }
  const relativePath = writeChannelConfig(cwd, serverName, 'holodeck', ['channel', 'run', agent.id], existing?.relativePath)

  console.log(`${agent.name} is ready in this folder.`)
  console.log('Start it with: holodeck agent start')
  if (verbose) {
    console.log(`\nSetup file: ${relativePath}`)
    console.log(`Starting it runs: claude ${claudeArguments({ relativePath, serverName, agentId: agent.id }, [], agent).join(' ')}`)
    console.log(
      'Claude Code may print "no MCP server configured with that name" at startup; the Agent still loads. Each Agent has its own file, so other Agents can work from this same folder in their own sessions.',
    )
  }
  if (isMissingFromGitIgnore(cwd, relativePath)) {
    console.log(
      `\nHeads up: ${relativePath} isn't ignored by git in this repository. It names your own Agent, so it shouldn't be committed (a teammate using it would try to start an Agent that isn't theirs). Add .holodeck/ to your .gitignore, or to .git/info/exclude to keep it local to this clone.`,
    )
  }
  return { relativePath, serverName, agentId: agent.id }
}

// "Agent live activity" Intention, Task 3/7 (HOL-163): makes the session
// observable by pointing Claude Code's own hooks back at the Channel's own
// MCP server (channelServer.ts's ACTIVITY_HOOK_TOOL). `mcp_tool`, not
// `command`/`http` (the spike's own measured recommendation — no process
// spawn per tool call). `--settings` ADDS to the user's/project's own hooks
// rather than replacing them (verified in the spike) — this is deliberately
// never combined with `disableAllHooks`, which the spike also verified
// silently kills every hook, including this one.
//
// Each event gets its own `input` template, listing only the fields that
// event actually has (`duration_ms` only exists on PostToolUse, for
// instance) — and, just as importantly, never `${tool_input}` or
// `${tool_response}`. Claude Code only ever substitutes what a template
// names, so the full tool input/output this design excludes is never sent
// to this tool call in the first place, whatever channelActivity.ts's
// handler does with what it does receive.
//
// V2 (docs/agent-live-activity-v2.md, sections 3.1 and 6.1): every hook also
// templates `agent_id`/`agent_type` (present only inside a subagent) and the
// Holodeck tools' own `taskId` argument. `holodeckServer` is a constant: the
// channel process doesn't know its own config name, and comparing it with
// `${mcp_server.name}` is what keeps other MCP servers' (or Claude Code's own
// TaskUpdate's) `taskId` from being read as a Holodeck Task.
function buildActivityHookSettings(serverName: string): object {
  const common = { sessionId: '${session_id}', promptId: '${prompt_id}', agentId: '${agent_id}', agentType: '${agent_type}' }
  const hook = (kind: string, fields: Record<string, string> = {}) => [
    { hooks: [{ type: 'mcp_tool', server: serverName, tool: ACTIVITY_HOOK_TOOL, input: { kind, ...common, ...fields } }] },
  ]
  const tool = { toolName: '${tool_name}', toolUseId: '${tool_use_id}' }
  return {
    hooks: {
      UserPromptSubmit: hook('turn_started'),
      PreToolUse: hook('tool_started', { ...tool, taskId: '${tool_input.taskId}', mcpServer: '${mcp_server.name}', holodeckServer: serverName }),
      PermissionRequest: hook('tool_awaiting_permission', { toolName: '${tool_name}' }),
      PostToolUse: hook('tool_succeeded', { ...tool, durationMs: '${duration_ms}' }),
      PostToolUseFailure: hook('tool_failed', { ...tool, durationMs: '${duration_ms}', isInterrupt: '${is_interrupt}' }),
      SubagentStart: hook('subagent_started'),
      SubagentStop: hook('subagent_stopped'),
      Stop: hook('turn_stopped'),
      StopFailure: hook('turn_failed'),
      SessionEnd: hook('session_ended'),
    },
    // A real end-to-end run found the tool has to be LISTED for Claude Code
    // to dispatch an `mcp_tool` hook to it at all (channelServer.ts's own
    // note on ACTIVITY_HOOK_TOOL_DESCRIPTOR) — which means the model can see
    // it too. This deny rule is the attempt at closing that back open: scope
    // item 4's own requirement was "never callable by the model", not just
    // "hidden from a list", so a description alone (soft, ignorable) isn't
    // enough. NOT YET CONFIRMED whether a deny rule also blocks the hook's
    // OWN dispatch of the same tool (undocumented either way) — this needs
    // a real test to confirm the hook still fires WITH this rule in place,
    // not just that the model can't call it directly.
    permissions: { deny: [`mcp__${serverName}__${ACTIVITY_HOOK_TOOL}`] },
  }
}

// The Agent's model and effort from Holodeck go first as `--model` and
// `--effort`; one the person passes themselves after `--` wins over it.
function claudeArguments(config: ChannelConfig, extra: string[], runner: RunnerSettings): string[] {
  const passed = (flag: string) => extra.some((argument) => argument === flag || argument.startsWith(`${flag}=`))
  return [
    ...(runner.model !== null && !passed('--model') ? ['--model', runner.model] : []),
    ...(runner.effort !== null && !passed('--effort') ? ['--effort', runner.effort] : []),
    '--mcp-config',
    config.relativePath,
    '--dangerously-load-development-channels',
    `server:${config.serverName}`,
    ...(passed('--settings') ? [] : ['--settings', JSON.stringify(buildActivityHookSettings(config.serverName))]),
    ...extra,
  ]
}

async function startConfigured(entry: ConfiguredAgent, extra: string[], verbose: boolean): Promise<void> {
  const executable = resolveClaudeExecutable(process.platform, process.env)
  if (!executable) {
    console.log("Claude Code (`claude`) isn't on your PATH, so there's nothing to start it with. Install it and try again.")
    process.exitCode = 1
    return
  }
  const args = claudeArguments(entry.config, extra, entry.runner)
  console.log(`Starting ${entry.name}...`)
  if (verbose) {
    console.log(`  claude ${args.join(' ')}`)
  }
  try {
    process.exitCode = await launchClaude(executable, args, process.cwd())
  } catch (error) {
    console.log(`Couldn't start Claude Code: ${errorMessage(error)}`)
    process.exitCode = 1
  }
}

export async function runAgentSetup(options: { verbose?: boolean } = {}): Promise<void> {
  await maybeNoticeUpdate(readOwnVersion())
  let agents: AgentSummary[]
  try {
    agents = await listMyAgents()
  } catch (error) {
    console.log(errorMessage(error))
    return
  }

  const ready = agents.filter((agent) => SETUP_MODES.includes(agent.connectionMode) && canRunVendor(agent))
  const notYet = agents.filter((agent) => agent.connectionMode !== 'session' && !ready.includes(agent))
  if (ready.length === 0) {
    console.log(
      "None of your Agents can be set up here yet. In Holodeck, create an Agent of type Channel (Manage Agents), then run this again.",
    )
    if (notYet.length > 0) {
      console.log(`${notYet.map((agent) => agent.name).join(', ')} can't be set up from the command line yet.`)
    }
    return
  }
  if (agents.some((agent) => agent.connectionMode === 'session')) {
    console.log('Session (MCP) Agents connect through Claude Desktop or Claude Code, so there is nothing to set up for them here.')
  }
  if (notYet.length > 0) {
    console.log(`${notYet.map((agent) => agent.name).join(', ')} can't be set up from the command line yet.`)
  }

  const agent = await select({
    message: 'Which Agent do you want to set up here?',
    choices: ready.map((candidate) => ({ name: candidate.name, value: candidate })),
  })
  const configured = await setUpChannelAgent(agent, Boolean(options.verbose))
  if (!configured || !isInteractive()) {
    return
  }
  if (await confirm({ message: `Start ${agent.name} now?`, default: true })) {
    await startConfigured({ config: configured, name: agent.name, runner: { model: agent.model, effort: agent.effort }, available: true }, [], Boolean(options.verbose))
  }
}

export async function runAgentStart(extraArguments: string[], options: { verbose?: boolean } = {}): Promise<void> {
  await maybeNoticeUpdate(readOwnVersion())
  const configs = findChannelConfigs(process.cwd())
  if (configs.length === 0) {
    console.log('No Agents are set up in this folder yet. Run: holodeck agent setup')
    return
  }
  const resolved = await resolveConfigured(configs)
  if ('error' in resolved) {
    console.log(resolved.error)
    return
  }
  const { entries, namesMayBeStale } = resolved

  let chosen: ConfiguredAgent
  if (entries.length === 1) {
    // Nothing to choose: say which one, then go.
    chosen = entries[0] as ConfiguredAgent
    if (!chosen.available) {
      console.log(`${chosen.name} is ${chosen.problem}. Run: holodeck agent setup`)
      return
    }
  } else if (entries.every((entry) => !entry.available)) {
    console.log('None of the Agents set up in this folder can be started any more. Run: holodeck agent setup')
    return
  } else {
    chosen = await select({
      message: 'Which Agent should start?',
      choices: entries.map((entry) => ({ name: entry.name, value: entry, disabled: entry.available ? false : (entry.problem ?? true) })),
    })
  }
  if (namesMayBeStale) {
    console.log("(Couldn't reach Holodeck, so names may be out of date.)")
  }
  await startConfigured(chosen, extraArguments, Boolean(options.verbose))
}

export async function runAgentList(): Promise<void> {
  const configs = findChannelConfigs(process.cwd())
  if (configs.length === 0) {
    console.log('No Agents are set up in this folder yet. Run: holodeck agent setup')
    return
  }
  const resolved = await resolveConfigured(configs)
  if ('error' in resolved) {
    console.log(resolved.error)
    return
  }
  for (const entry of resolved.entries) {
    console.log(entry.available ? entry.name : `${entry.name} (${entry.problem})`)
  }
  if (resolved.namesMayBeStale) {
    console.log("(Couldn't reach Holodeck, so names may be out of date.)")
  }
}
