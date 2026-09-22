import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isSea } from 'node:sea'
import { confirm } from '@inquirer/prompts'
import { configDir, dataDir } from './paths.js'

// `holodeck uninstall` (HOL-158): removes the binary and its PATH entry.
// Removing the config/data directories (settings, personas, the
// `holodeck login` credential) is asked about separately and defaults to
// no — those are exactly what would need re-entering on a reinstall, so
// losing them isn't the same class of action as removing the binary.

const isInteractive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY)

// Same line `install.sh` appends to a shell profile when `~/.local/bin`
// isn't already on PATH — matched exactly so this only ever removes a line
// it (or a person copying its instructions) actually wrote, never anything
// else that happens to mention PATH.
function pathLineFor(installDir: string): string {
  return `export PATH="${installDir}:$PATH"`
}

function removePathLineFromProfile(profilePath: string, installDir: string): boolean {
  if (!fs.existsSync(profilePath)) {
    return false
  }
  const line = pathLineFor(installDir)
  const content = fs.readFileSync(profilePath, 'utf8')
  if (!content.includes(line)) {
    return false
  }
  const updated = content
    .split('\n')
    .filter((existing) => existing.trim() !== line)
    .join('\n')
  fs.writeFileSync(profilePath, updated)
  return true
}

// Removing a Windows User `Path` entry means rewriting the registry-backed
// value — `setx` is the obvious tool but truncates PATH at 1024 characters
// when it writes it back (a real, well-known footgun), so this shells out
// to the same .NET API `install.ps1` already uses instead, which has no
// such limit.
function removeFromWindowsUserPath(installDir: string): void {
  const script = `
    $dir = [Environment]::GetEnvironmentVariable('Path', 'User') -split ';' | Where-Object { $_ -ne '' -and $_ -ne '${installDir.replace(/'/g, "''")}' }
    [Environment]::SetEnvironmentVariable('Path', ($dir -join ';'), 'User')
  `
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
}

// Windows won't let this process delete the very .exe it's running from —
// but it CAN rename it out of the way (same trick `holodeck update` uses),
// then hand off deleting the renamed file to a short-lived detached helper
// that outlives this process. A temp .bat FILE, not an inline `cmd /c
// "...`" command-line string: building that string by hand for a path that
// can contain spaces or backslashes is exactly the kind of quoting that
// silently breaks depending on what invoked this process (confirmed live —
// an inline string here failed silently under a Git Bash parent, the
// helper never actually ran). The batch file also deletes itself last
// (`%~f0`, its own full path), so nothing is left behind either way.
function scheduleWindowsSelfDelete(execPath: string): void {
  const oldPath = `${execPath}.uninstall`
  fs.rmSync(oldPath, { force: true })
  fs.renameSync(execPath, oldPath)
  const scriptPath = path.join(os.tmpdir(), `holodeck-uninstall-${process.pid}.bat`)
  // A single delete attempt right after the rename found the file still
  // transiently locked in testing (most likely a moment of antivirus
  // scanning the just-renamed, unsigned binary) even though nothing was
  // still running from it — so this retries for a few seconds instead of
  // trying exactly once.
  fs.writeFileSync(
    scriptPath,
    [
      '@echo off',
      'for /l %%i in (1,1,10) do (',
      `  del /f /q "${oldPath}" 2>nul`,
      `  if not exist "${oldPath}" goto done`,
      '  ping 127.0.0.1 -n 2 > nul',
      ')',
      ':done',
      'del /f /q "%~f0"',
      '',
    ].join('\r\n'),
  )
  const child = spawn('cmd.exe', ['/c', scriptPath], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

export async function runUninstall(): Promise<void> {
  if (!isSea()) {
    console.log("`holodeck uninstall` only makes sense on an installed release build, not when running from source. Just delete this checkout instead.")
    return
  }

  const execPath = process.execPath
  const installDir = path.dirname(execPath)

  if (process.platform === 'win32') {
    scheduleWindowsSelfDelete(execPath)
    try {
      removeFromWindowsUserPath(installDir)
    } catch {
      console.log(`Removed the binary, but couldn't update your PATH automatically — remove ${installDir} from it yourself if you want.`)
    }
  } else {
    // POSIX lets any process unlink its own running executable — the inode
    // stays valid for as long as this process keeps it open, then is
    // actually freed, no special handling needed.
    fs.rmSync(execPath, { force: true })
    const shell = process.env.SHELL ?? ''
    const profile = shell.endsWith('/zsh') ? '.zshrc' : shell.endsWith('/bash') ? '.bashrc' : undefined
    if (profile) {
      removePathLineFromProfile(path.join(os.homedir(), profile), installDir)
    }
  }

  console.log('holodeck has been uninstalled.')

  const settingsPaths = [configDir, dataDir]
  if (!isInteractive()) {
    console.log(`Your settings, personas and login are still at:\n  ${configDir}\n  ${dataDir}\nRemove them yourself if you want, or run \`holodeck uninstall\` again from a terminal to be asked.`)
    return
  }
  const removeSettings = await confirm({
    message: 'Also remove your holodeck settings, personas and login credential?',
    default: false,
  })
  if (removeSettings) {
    for (const settingsPath of settingsPaths) {
      fs.rmSync(settingsPath, { recursive: true, force: true })
    }
    console.log('Removed.')
  }
}
