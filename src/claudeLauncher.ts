import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Starts Claude Code for `holodeck agent start` (HOL-135). The delicate part
// is FINDING the executable, and it differs by operating system:
//
// - macOS / Linux: the PATH lookup is what `execvp` does anyway. It works for
//   the native install (`~/.local/bin/claude`), Homebrew and an npm install
//   (a shebang script). A shell alias or function is not an executable, so it
//   is simply not found here: reported as "not on your PATH".
// - Windows: the native install is `claude.exe`, which spawns directly. An npm
//   install only provides `claude.cmd`, and Node can neither find a bare
//   `claude` for that (no PATHEXT lookup without a shell) nor spawn the `.cmd`
//   by path (refused since Node 20.12, `EINVAL`). So the lookup is done here,
//   honoring PATHEXT, and a `.cmd`/`.bat` is started through a shell.
//
// The lookup takes the platform and environment as parameters (and the file
// check as a dependency) so both branches can be checked from any machine.

export interface ClaudeExecutable {
  path: string
  // Windows `.cmd`/`.bat` only: must be started through a shell.
  needsShell: boolean
}

interface LookupDeps {
  isFile: (candidate: string) => boolean
}

const defaultDeps: LookupDeps = {
  isFile: (candidate) => {
    try {
      return fs.statSync(candidate).isFile()
    } catch {
      return false
    }
  },
}

// Windows environment variable names are case-insensitive (`Path` vs `PATH`).
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

export function resolveClaudeExecutable(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  deps: LookupDeps = defaultDeps,
): ClaudeExecutable | undefined {
  const isWindows = platform === 'win32'
  const pathModule = isWindows ? path.win32 : path.posix
  const dirs = (envValue(env, 'PATH') ?? '').split(isWindows ? ';' : ':').filter((dir) => dir !== '')

  if (!isWindows) {
    for (const dir of dirs) {
      const candidate = pathModule.join(dir, 'claude')
      if (deps.isFile(candidate)) {
        return { path: candidate, needsShell: false }
      }
    }
    return undefined
  }

  // PATHEXT order decides between `claude.exe` and `claude.cmd` in one folder;
  // an earlier PATH folder always wins over a later one.
  const extensions = (envValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((extension) => extension !== '')
    .map((extension) => extension.toLowerCase())
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = pathModule.join(dir, `claude${extension}`)
      if (deps.isFile(candidate)) {
        return { path: candidate, needsShell: extension === '.cmd' || extension === '.bat' }
      }
    }
  }
  return undefined
}

// One argument for cmd.exe: plain characters pass as they are; anything else
// (a space in a folder name, a `&` or `|`, a quote) goes inside double quotes
// with inner quotes doubled. Only used for the Windows `.cmd` case, since a
// shell joins arguments without quoting them and Windows user folders often
// contain spaces. POSIX never uses a shell here.
export function quoteForCmd(argument: string): string {
  if (/^[A-Za-z0-9_\-.:/\\=@,+]+$/.test(argument)) {
    return argument
  }
  return `"${argument.replace(/"/g, '""')}"`
}

// Runs Claude Code with the terminal handed over to it, and resolves to its
// exit code. While it runs, Ctrl+C reaches both this process and `claude` (same
// foreground process group); this one must ignore it, otherwise it exits first
// and hands the terminal back while Claude Code is still running.
export function launchClaude(executable: ClaudeExecutable, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ignoreInterrupt = () => {}
    process.on('SIGINT', ignoreInterrupt)
    const finish = (settle: () => void) => {
      process.off('SIGINT', ignoreInterrupt)
      settle()
    }

    const child = executable.needsShell
      ? spawn([executable.path, ...args].map(quoteForCmd).join(' '), { stdio: 'inherit', cwd, shell: true })
      : spawn(executable.path, args, { stdio: 'inherit', cwd })
    child.once('error', (error) => finish(() => reject(error)))
    child.once('exit', (code) => finish(() => resolve(code ?? 1)))
  })
}
