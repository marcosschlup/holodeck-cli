import fs from 'node:fs'
import path from 'node:path'
import { isSea } from 'node:sea'
import { resolveClaudeExecutable } from './claudeLauncher.js'
import { loadLoginCredential } from './loginCredential.js'
import { readOwnVersion } from './version.js'

// `holodeck doctor` (HOL-158): the handful of things a support
// conversation would otherwise have to ask one-by-one, in one command.
// Purely a diagnostic — it names a problem, it never fixes one itself
// (that's `holodeck update`/`holodeck login`/re-running the install
// command, as each finding below says).

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

// The same PATH/PATHEXT walk claudeLauncher.ts's own lookup does for
// `claude`, generalized to any bare executable name rather than shared with
// it — that module's `ClaudeExecutable` also tracks `needsShell` for
// actually *launching* a `.cmd`, which nothing here needs, this only ever
// reports a path.
function findOnPath(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  const isWindows = platform === 'win32'
  const pathModule = isWindows ? path.win32 : path.posix
  const dirs = (envValue(env, 'PATH') ?? '').split(isWindows ? ';' : ':').filter((dir) => dir !== '')
  const extensions = isWindows ? (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '') : ['']
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = pathModule.join(dir, `${name}${extension}`)
      try {
        if (fs.statSync(candidate).isFile()) {
          return candidate
        }
      } catch {
        // Not there — keep looking.
      }
    }
  }
  return undefined
}

interface Finding {
  ok: boolean
  message: string
}

function checkHolodeckOnPath(): Finding {
  if (!isSea()) {
    return { ok: true, message: 'Running from source (dev, tsx/node dist/cli.js) — PATH checks do not apply.' }
  }
  const onPath = findOnPath('holodeck', process.platform, process.env)
  if (!onPath) {
    return { ok: false, message: "isn't on your PATH. Re-run the install command from the README." }
  }
  // Resolved (follows a symlink to where it actually points) and
  // case-normalized before comparing — Windows paths compare
  // case-insensitively, and `fs.realpathSync` also settles short-vs-long
  // path forms.
  const resolved = fs.realpathSync(onPath)
  const running = fs.realpathSync(process.execPath)
  if (resolved.toLowerCase() !== running.toLowerCase()) {
    return {
      ok: false,
      message: `PATH resolves to ${onPath}, a different copy than the one running this check (${process.execPath}) — you likely have two installs. Remove the stale one.`,
    }
  }
  return { ok: true, message: `on your PATH at ${onPath}.` }
}

function checkClaude(): Finding {
  const executable = resolveClaudeExecutable(process.platform, process.env)
  if (!executable) {
    return { ok: false, message: "isn't on your PATH. Install Claude Code: https://code.claude.com/docs/en/setup" }
  }
  return { ok: true, message: `on your PATH at ${executable.path}.` }
}

// Only reports whether a login exists, not whether it's genuinely still
// valid: knowing that for certain would need a real request to Holodeck
// (the refresh token's own remaining lifetime isn't stored locally, only
// the short-lived access token's `expiresAt` is) — more than a fast,
// offline-first diagnostic should cost. An expired access token alone is
// normal and refreshes on next use, so it's noted, not flagged as a
// problem.
function checkLogin(): Finding {
  const credential = loadLoginCredential()
  if (!credential) {
    return { ok: false, message: 'Not signed in. Run `holodeck login`.' }
  }
  const accessExpired = Date.now() >= credential.expiresAt
  return {
    ok: true,
    message: `Signed in to ${credential.serverUrl}${accessExpired ? ' (access token expired; refreshes automatically on next use)' : ''}.`,
  }
}

export function runDoctor(): void {
  const findings: { label: string; ok: boolean; message: string }[] = [
    { label: 'holodeck', ...checkHolodeckOnPath() },
    { label: 'claude', ...checkClaude() },
    { label: 'Holodeck login', ...checkLogin() },
    { label: 'Version', ok: true, message: readOwnVersion() },
  ]
  for (const finding of findings) {
    console.log(`${finding.ok ? '✓' : '✗'} ${finding.label}: ${finding.message}`)
  }
}
