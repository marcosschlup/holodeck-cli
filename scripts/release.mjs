// Cuts a new holodeck-cli release in one command: bump version, tag, push.
// Pushing the tag is the trigger — `.github/workflows/release.yml` builds
// every platform's binary and publishes the GitHub Release itself (HOL-153,
// Holodeck CLI distribution Intention, task-manager repo). This script used
// to also build the SEA binary locally and run `gh release create` (HOL-80);
// that only ever covered whichever one platform ran it, so with several
// target platforms now built in CI it doesn't belong here — releasing no
// longer needs the `gh` CLI, or even Node's SEA tooling, on anyone's machine.
//
//   npm run release           (defaults to a patch bump)
//   npm run release -- minor
//   npm run release -- major
//
// Preconditions this script assumes but doesn't set up itself (fails fast
// with a clear message if missing, rather than half-running): a clean git
// working tree and a `git remote` to push to.

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
  // On Windows, `npm` (unlike `git`) is a `.cmd` shim, not a real .exe.
  // `execFileSync` can't spawn a `.cmd` at all without `shell: true` (Node
  // rejects it outright since 20.12, `EINVAL`) — the same gotcha
  // `claudeLauncher.ts` already works around for `claude.cmd`. With
  // `shell: true`, Node only concatenates `command` and `args` into one
  // shell command line rather than escaping each argument (its own
  // DEP0190 warning) — safe here only because every argument this script
  // ever passes is one of our own fixed literals (`version`, a bump type
  // already checked against an allow-list above, `push`, `origin`, a tag
  // built from `package.json`'s own version), never anything from outside
  // this file.
  const needsShell = process.platform === 'win32' && command === 'npm'
  return execFileSync(command, args, { cwd: repoRoot, encoding: 'utf8', shell: needsShell, ...options }).trim()
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
}

checkPreconditions()

console.log(`Bumping version (${bump})...`)
// Bumps package.json, commits ("<version>"), and tags ("v<version>") in
// one step — no reason to hand-roll what `npm version` already does.
run('npm', ['version', bump])

const { version } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const tag = `v${version}`

console.log('Pushing commit and tag...')
run('git', ['push'])
run('git', ['push', 'origin', tag])

console.log(`\nPushed ${tag} — the Release workflow will build every platform and publish it: https://github.com/marcosschlup/holodeck-cli/actions`)
