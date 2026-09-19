import fs from 'node:fs'
import path from 'node:path'

// The Claude Code project config `channel add` writes into (HOL-130) —
// `.mcp.json` at the root of whatever project directory the command is
// run from, same file Claude Code itself reads on session start. Kept
// generic (`Record<string, unknown>` for a server entry, not a typed
// shape) since this only ever adds/replaces one `mcpServers` key and must
// never touch any other key a human or another tool put in this file.
interface McpConfigFile {
  mcpServers?: Record<string, unknown>
  [key: string]: unknown
}

function mcpConfigPath(projectDir: string): string {
  return path.join(projectDir, '.mcp.json')
}

function readMcpConfig(projectDir: string): McpConfigFile {
  const filePath = mcpConfigPath(projectDir)
  if (!fs.existsSync(filePath)) {
    return {}
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as McpConfigFile
}

// The `args` of an existing entry, if any - lets `channel add` notice a
// name collision (two different Agents that slug to the same server name)
// before overwriting someone else's entry.
export function findMcpServerArgs(projectDir: string, serverName: string): string[] | undefined {
  const entry = readMcpConfig(projectDir).mcpServers?.[serverName] as { args?: string[] } | undefined
  return entry?.args
}

// Adds or replaces exactly one `mcpServers` entry, preserving every other
// key in the file (other servers, and anything else a human or another
// tool put there) — re-running `channel add` for the same persona updates
// its entry in place instead of leaving a stale duplicate, same
// upsert convention store.ts/oauthCredentials.ts already use.
export function upsertMcpServerEntry(projectDir: string, serverName: string, command: string, args: string[]): void {
  const config = readMcpConfig(projectDir)
  config.mcpServers = { ...config.mcpServers, [serverName]: { command, args } }
  fs.writeFileSync(mcpConfigPath(projectDir), `${JSON.stringify(config, null, 2)}\n`)
}
