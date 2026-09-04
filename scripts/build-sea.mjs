// Builds a Node Single Executable Application (SEA) from `src/cli.ts` —
// see PLAN.md "Distribution/packaging" (task-manager repo) for why SEA
// over requiring end users to have Node installed. Manual today (run
// `npm run build:sea` locally, upload the result to a GitHub Release by
// hand); a version-bump + build automation script is tracked separately
// as follow-up work, deliberately not built here yet.
//
// Steps, per Node's own SEA docs (https://nodejs.org/api/single-executable-applications.html):
//   1. Bundle src/cli.ts + all its deps into one CommonJS file (esbuild) —
//      SEA embeds exactly one script, it doesn't resolve `import`s or
//      `node_modules` on its own, and (see below) its main script has to
//      be CommonJS today anyway.
//   2. Generate the SEA prep blob from that bundle (`--experimental-sea-config`).
//   3. Copy the current `node` binary to the output executable's name.
//   4. Inject the blob into that copy (`postject`).
//   5. macOS only: strip then re-apply an ad-hoc code signature — a
//      SEA binary is a modified `node` binary, and macOS refuses to run
//      one whose original signature no longer matches its (now
//      different) contents.
//
// Untested on macOS/Linux as of this writing (only Windows has been run
// here) — the darwin/posix branches follow the documented steps but
// haven't been exercised on real hardware yet; verify them when the
// multi-OS CI matrix (PLAN.md, deferred) actually builds those targets.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const outDir = path.join(repoRoot, 'dist-sea')
// CJS, not ESM — confirmed live (2026-09-04): Node's SEA loader (v24)
// only reliably runs a CommonJS main script; a bundled `.mjs` main
// throws "Cannot use import statement outside a module" at runtime even
// though the file itself is valid ESM. ESM entry support is still
// landing upstream (https://github.com/nodejs/node/pull/61813, adding a
// `mainFormat` sea-config field), not yet something to depend on.
const bundlePath = path.join(outDir, 'bundle.cjs')
const blobPath = path.join(outDir, 'sea-prep.blob')
const seaConfigPath = path.join(outDir, 'sea-config.json')
const exeName = process.platform === 'win32' ? 'holodeck.exe' : 'holodeck'
const exePath = path.join(outDir, exeName)

const { version } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))

fs.mkdirSync(outDir, { recursive: true })

console.log(`Bundling src/cli.ts (v${version}) -> ${path.relative(repoRoot, bundlePath)}`)
await esbuild.build({
  entryPoints: [path.join(repoRoot, 'src/cli.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: bundlePath,
  // `readOwnVersion()`'s dead (SEA build never takes it) `import.meta.url`
  // fallback branch still gets parsed and would otherwise warn on every
  // build — harmless, but noisy.
  logOverride: { 'empty-import-meta': 'silent' },
  define: {
    // Replaces `readOwnVersion()`'s SEA branch (src/cli.ts) — the
    // running binary has no `package.json` next to it to read at
    // runtime.
    __HOLODECK_SEA_VERSION__: JSON.stringify(version),
    // At least one dependency calls `createRequire(import.meta.url)` at
    // module scope (confirmed live, 2026-09-04: crashes on startup
    // otherwise). esbuild's CJS output leaves `import.meta.url` as
    // `undefined` since there's no real ESM module URL in a CJS bundle
    // — `createRequire` then rejects that `undefined` before the
    // binary gets anywhere near our own code. Standing in the bundle's
    // own file path as a fake-but-valid `file://` URL is the closest
    // thing to "what this would be if it really were the ESM module it
    // was written as" and is enough for `createRequire` to construct a
    // (probably never actually exercised) require function.
    'import.meta.url': JSON.stringify(pathToFileURL(bundlePath).href),
  },
})

// Absolute paths — `main`/`output` are resolved against the process's
// cwd when `--experimental-sea-config` runs, not against the config
// file's own directory, so a relative path here would depend on where
// this script happens to be invoked from.
fs.writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      main: bundlePath,
      output: blobPath,
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  ),
)

console.log('Generating SEA prep blob...')
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' })

console.log(`Copying node binary -> ${path.relative(repoRoot, exePath)}`)
fs.copyFileSync(process.execPath, exePath)

if (process.platform === 'darwin') {
  execFileSync('codesign', ['--remove-signature', exePath], { stdio: 'inherit' })
}

console.log('Injecting blob into the binary (postject)...')
const postjectCli = path.join(path.dirname(fileURLToPath(import.meta.resolve('postject/package.json'))), 'dist/cli.js')
const postjectArgs = [
  postjectCli,
  exePath,
  'NODE_SEA_BLOB',
  blobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]
if (process.platform === 'darwin') {
  postjectArgs.push('--macho-segment-name', 'NODE_SEA')
}
execFileSync(process.execPath, postjectArgs, { stdio: 'inherit' })

if (process.platform !== 'win32') {
  fs.chmodSync(exePath, 0o755)
}
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--sign', '-', exePath], { stdio: 'inherit' })
}

const { size } = fs.statSync(exePath)
console.log(`\nBuilt ${path.relative(repoRoot, exePath)} (${(size / 1024 / 1024).toFixed(1)} MB)`)
