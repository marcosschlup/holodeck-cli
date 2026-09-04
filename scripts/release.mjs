// Cuts a new agent-connector release in one command: bump version, build
// the SEA binary, tag + push, publish a GitHub Release with the binary
// attached. HOL-80 — the manual "build locally, upload the file" flow
// (HOL-79) worked but was still several hand-run steps every time.
//
//   npm run release           (defaults to a patch bump)
//   npm run release -- minor
//   npm run release -- major
//
// Orchestrates `scripts/build-sea.mjs`, doesn't duplicate its bundling
// logic. Preconditions this script assumes but doesn't set up itself
// (fails fast with a clear message if missing, rather than half-running):
// a clean git working tree, a `git remote` to push to, and the `gh` CLI
// installed + authenticated (`gh auth login`).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bump = process.argv[2] ?? 'patch'

if (!['patch', 'minor', 'major'].includes(bump)) {
  console.error(`Unknown bump type "${bump}" — expected one of: patch, minor, major.`)
  process.exit(1)
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: repoRoot, encoding: 'utf8', ...options }).trim()
}

function checkPreconditions() {
  const dirty = run('git', ['status', '--porcelain'])
  if (dirty) {
    console.error('Working tree has uncommitted changes — commit or stash them before releasing:\n' + dirty)
    process.exit(1)
  }

  const remotes = run('git', ['remote'])
  if (!remotes) {
    console.error('No `git remote` configured — add one (e.g. `git remote add origin <url>`) before releasing.')
    process.exit(1)
  }

  try {
    run('gh', ['auth', 'status'])
  } catch {
    console.error('`gh` CLI not found or not authenticated — install from https://cli.github.com and run `gh auth login`.')
    process.exit(1)
  }
}

checkPreconditions()

console.log(`Bumping version (${bump})...`)
// Bumps package.json, commits ("<version>"), and tags ("v<version>") in
// one step — no reason to hand-roll what `npm version` already does.
run('npm', ['version', bump])

const { version } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const tag = `v${version}`

console.log('Building SEA binary...')
run('npm', ['run', 'build:sea'], { stdio: 'inherit' })

const builtExeName = process.platform === 'win32' ? 'holodeck.exe' : 'holodeck'
const builtExePath = path.join(repoRoot, 'dist-sea', builtExeName)

// Asset name carries platform + arch so future builds for other OSes
// (PLAN.md's deferred multi-OS CI matrix) can attach to the same
// release without overwriting each other.
const assetExt = process.platform === 'win32' ? '.exe' : ''
const assetName = `holodeck-${process.platform}-${process.arch}${assetExt}`
const assetPath = path.join(repoRoot, 'dist-sea', assetName)
fs.copyFileSync(builtExePath, assetPath)

console.log('Pushing commit and tag...')
run('git', ['push'])
run('git', ['push', 'origin', tag])

console.log(`Publishing GitHub Release ${tag}...`)
run('gh', ['release', 'create', tag, assetPath, '--title', tag, '--generate-notes'], { stdio: 'inherit' })

console.log(`\nRelease ${tag} published with ${assetName}.`)
