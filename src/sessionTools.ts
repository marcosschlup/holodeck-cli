// Holodeck's tools as a session gets them (HOL-236), from a Channel
// (channelServer.ts) or a Headless run (headlessMcp.ts).
//
// Claude Code defers MCP tools by default: only their names load when the
// session starts, and a definition arrives when the model searches for it. A
// model that doesn't search answers "I don't have that tool", which is what a
// new person's Agent said on its first notice. An Agent started by this CLI
// is there to work in Holodeck, so its tools are marked to load upfront: about
// 7,600 tokens for a Channel Agent's 37 tools, measured on 2026-10-10.
// Whoever wants them deferred again sets "alwaysLoad": false on the server in
// the session's MCP config, which wins over this mark.

const ALWAYS_LOAD = 'anthropic/alwaysLoad'

interface ListedTool {
  name: string
  _meta?: Record<string, unknown>
}

// `hidden`: the tools the CLI answers itself and the model must not call.
export function toolsForSession<Tool extends ListedTool>(tools: Tool[], hidden: ReadonlySet<string>): Tool[] {
  return tools.filter((tool) => !hidden.has(tool.name)).map((tool) => ({ ...tool, _meta: { ...tool._meta, [ALWAYS_LOAD]: true } }))
}
