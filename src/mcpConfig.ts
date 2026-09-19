import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Where `channel add` (HOL-130) keeps a Channel's Claude Code MCP config: ONE
// FILE PER AGENT under `.holodeck/` in the project folder, loaded per session
// with `claude --mcp-config .holodeck/<file>`, NOT a shared `.mcp.json`.
//
// Why not `.mcp.json`: Claude Code starts EVERY server listed there when a
// session opens, whichever one `--dangerously-load-development-channels
// server:<name>` registers as the channel (checked against Claude Code
// 2.1.278: both servers start, and both get an identical `initialize`, so a
// server can't tell whether it is the channel). Two Agents in one `.mcp.json`
// would bring both online in every session, with the unflagged one's events
// silently dropped, and two sessions would keep evicting each other's
// connection. With one file per Agent and the file chosen at launch, a
// session starts only its own Agent's Channel process, so any number of
// Agents can share a folder, each in its own session.
const CONFIG_DIR = '.holodeck'
const FILE_SUFFIX = '.mcp.json'

interface McpConfigFile {
  mcpServers?: Record<string, { command?: string; args?: unknown }>
}

export interface ChannelConfig {
  // Relative to the project folder, e.g. `.holodeck/holodeck-ana.mcp.json`.
  relativePath: string
  serverName: string
  agentId: string
}

// The Agent a config entry runs, recognized by its `channel run <agentId>`
// arguments wherever they sit in the argument list (the command itself
// varies: a `holodeck` binary, or `node .../cli.ts` when running from source).
function agentIdOf(args: unknown): string | undefined {
  if (!Array.isArray(args)) {
    return undefined
  }
  const at = args.findIndex((arg, index) => arg === 'channel' && args[index + 1] === 'run')
  const agentId = at === -1 ? undefined : args[at + 2]
  return typeof agentId === 'string' ? agentId : undefined
}

// Every Channel config already written in this project folder.
export function findChannelConfigs(projectDir: string): ChannelConfig[] {
  const dir = path.join(projectDir, CONFIG_DIR)
  if (!fs.existsSync(dir)) {
    return []
  }
  const configs: ChannelConfig[] = []
  for (const fileName of fs.readdirSync(dir)) {
    if (!fileName.endsWith(FILE_SUFFIX)) {
      continue
    }
    let parsed: McpConfigFile
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, fileName), 'utf8')) as McpConfigFile
    } catch {
      continue
    }
    for (const [serverName, entry] of Object.entries(parsed.mcpServers ?? {})) {
      const agentId = agentIdOf(entry.args)
      if (agentId) {
        configs.push({ relativePath: path.join(CONFIG_DIR, fileName), serverName, agentId })
        break
      }
    }
  }
  return configs
}

// True when this server name is already used by a different file's config
// than the one that would be written - a name collision to avoid, since two
// Agents can share a name.
export function isServerNameTaken(projectDir: string, serverName: string): boolean {
  return fs.existsSync(path.join(projectDir, CONFIG_DIR, `${serverName}${FILE_SUFFIX}`))
}

// Writes (or replaces) the config file for one Channel and returns its path
// relative to the project folder. `relativePath` is given when the same Agent
// already has a file (kept under its existing name: the Agent may have been
// renamed since, and a second file for the same Agent would start two
// processes fighting over one connection).
export function writeChannelConfig(
  projectDir: string,
  serverName: string,
  command: string,
  args: string[],
  relativePath?: string,
): string {
  const target = relativePath ?? path.join(CONFIG_DIR, `${serverName}${FILE_SUFFIX}`)
  fs.mkdirSync(path.join(projectDir, CONFIG_DIR), { recursive: true })
  const config: McpConfigFile = { mcpServers: { [serverName]: { command, args } } }
  fs.writeFileSync(path.join(projectDir, target), `${JSON.stringify(config, null, 2)}\n`)
  return target
}

// The config names the person's own Agent, so committing it makes every
// teammate's setup try to start a channel for an Agent they don't own (which
// Holodeck refuses). True only when git is present, the folder is in a
// repository and the file is NOT ignored; anything else (no git, not a repo)
// says nothing rather than guessing.
export function isMissingFromGitIgnore(projectDir: string, relativePath: string): boolean {
  // `check-ignore -q`: exit 0 = ignored, 1 = not ignored, 128 = not a repo.
  const result = spawnSync('git', ['check-ignore', '-q', relativePath], { cwd: projectDir })
  return result.status === 1
}
