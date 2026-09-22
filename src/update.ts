import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isSea } from 'node:sea'

// `holodeck update` (HOL-155, Holodeck CLI distribution Intention,
// task-manager repo): replaces the running binary with the latest GitHub
// Release, the same one `.github/workflows/release.yml` (holodeck-cli repo)
// publishes and `install.sh`/`install.ps1` install from — same asset
// naming, same SHA256SUMS verification.

const REPO = 'marcosschlup/holodeck-cli'

interface LatestRelease {
  tag: string // e.g. "v0.1.1"
  version: string // "v" stripped, e.g. "0.1.1"
}

async function fetchLatestRelease(): Promise<LatestRelease> {
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`)
  if (!response.ok) {
    throw new Error(`Couldn't reach the GitHub Releases API (HTTP ${response.status}).`)
  }
  const body = (await response.json()) as { tag_name?: string }
  if (!body.tag_name) {
    throw new Error("The latest release has no tag_name — can't determine its version.")
  }
  return { tag: body.tag_name, version: body.tag_name.replace(/^v/, '') }
}

// Numeric dot-component comparison only — this CLI's own versions are plain
// `npm version` patch/minor/major bumps (scripts/release.mjs), never
// prerelease/build metadata, so a general semver library would be more than
// this needs.
function isNewer(candidate: string, current: string): boolean {
  const c = candidate.split('.').map(Number)
  const k = current.split('.').map(Number)
  for (let i = 0; i < Math.max(c.length, k.length); i += 1) {
    const cv = c[i] ?? 0
    const kv = k[i] ?? 0
    if (cv !== kv) {
      return cv > kv
    }
  }
  return false
}

// Same names `release.yml`'s build matrix uses.
function assetNameFor(platform: NodeJS.Platform, arch: string): string {
  const platformName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : null
  if (!platformName) {
    throw new Error(`Unsupported platform: ${platform}.`)
  }
  if (arch !== 'x64' && arch !== 'arm64') {
    throw new Error(`Unsupported architecture: ${arch}.`)
  }
  return `holodeck-${platformName}-${arch}${platform === 'win32' ? '.exe' : ''}`
}

async function downloadText(url: string): Promise<string> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Couldn't download ${url} (HTTP ${response.status}).`)
  }
  return response.text()
}

async function downloadBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Couldn't download ${url} (HTTP ${response.status}).`)
  }
  return Buffer.from(await response.arrayBuffer())
}

export interface UpdateStatus {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateStatus> {
  const latest = await fetchLatestRelease()
  return { currentVersion, latestVersion: latest.version, hasUpdate: isNewer(latest.version, currentVersion) }
}

// Windows only needs this: a previous update couldn't delete the renamed
// `<execPath>.old` while it was still running (see applyUpdate below), so a
// fresh start tries again. POSIX's atomic rename during an update never
// leaves anything behind, so there is nothing to clean up there. Called
// once at CLI startup (cli.ts's main()) for every command, including
// `channel run` — silent and best-effort either way, same "never let
// bookkeeping fail the actual command" posture as report_health.
export function cleanUpOldBinary(): void {
  if (process.platform !== 'win32') {
    return
  }
  try {
    fs.rmSync(`${process.execPath}.old`, { force: true })
  } catch {
    // Still in use (an even older session hasn't exited yet) — try again
    // next start.
  }
}

export interface ApplyUpdateResult {
  updated: boolean
  version: string
}

export async function applyUpdate(currentVersion: string): Promise<ApplyUpdateResult> {
  if (!isSea()) {
    throw new Error(
      '`holodeck update` only works on an installed release build, not when running from source (tsx/node dist/cli.js). Rebuild, or reinstall with the command from the README, instead.',
    )
  }

  const latest = await fetchLatestRelease()
  if (!isNewer(latest.version, currentVersion)) {
    return { updated: false, version: currentVersion }
  }

  const asset = assetNameFor(process.platform, process.arch)
  const baseUrl = `https://github.com/${REPO}/releases/download/${latest.tag}`
  const [binary, sums] = await Promise.all([downloadBuffer(`${baseUrl}/${asset}`), downloadText(`${baseUrl}/SHA256SUMS`)])

  const expectedLine = sums.split('\n').find((line) => line.trim().endsWith(asset))
  const expected = expectedLine?.trim().split(/\s+/)[0]
  if (!expected) {
    throw new Error(`${asset} isn't listed in ${latest.tag}'s SHA256SUMS — refusing to install an unverifiable binary.`)
  }
  const actual = createHash('sha256').update(binary).digest('hex')
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${asset} (expected ${expected}, got ${actual}) — not installing. Try again; if this keeps happening, please report it.`)
  }

  const execPath = process.execPath
  try {
    if (process.platform === 'win32') {
      // Windows won't let us overwrite a running .exe directly, but
      // renaming one is allowed even while it's executing (the same trick
      // install.ps1 uses) — this process, and any other `holodeck` already
      // running, keeps working from the renamed file until it exits.
      const oldPath = `${execPath}.old`
      fs.rmSync(oldPath, { force: true })
      fs.renameSync(execPath, oldPath)
      fs.writeFileSync(execPath, binary)
    } else {
      // POSIX: write next to the target — same directory, so the rename
      // below stays on one filesystem and is atomic — then rename over
      // it. Nothing is ever left to clean up here: the OLD inode stays
      // valid for whoever already has it open, exactly like install.sh's
      // own `mv`.
      const tmpPath = path.join(path.dirname(execPath), `.holodeck-update-${process.pid}`)
      fs.writeFileSync(tmpPath, binary, { mode: 0o755 })
      fs.chmodSync(tmpPath, 0o755) // `mode` above is still subject to umask; make sure it's executable regardless.
      fs.renameSync(tmpPath, execPath)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new Error(`${path.dirname(execPath)} isn't writable. Re-run the install command from the README instead of \`holodeck update\`.`)
    }
    throw error
  }

  return { updated: true, version: latest.version }
}
