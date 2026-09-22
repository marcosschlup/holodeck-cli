import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// `package.json`'s own version, single source of truth for `holodeck
// --version` rather than a hardcoded literal that could drift out of sync.
// `../package.json` resolves consistently whether this runs as `src/cli.ts`
// under tsx (dev) or as the built `dist/cli.js` (`npm run build`) — both
// sit one directory below the package root. A SEA binary has no such
// file next to it (the whole point is a single self-contained
// executable), so `scripts/build-sea.mjs` bakes the version in at bundle
// time via esbuild's `define`, replacing `__HOLODECK_SEA_VERSION__` with
// a real string literal — falls through to the file read whenever that
// replacement never happened (dev, and the plain `npm run build`).
//
// Its own module (not just a function in cli.ts) so `agentCommands.ts` can
// read it too (HOL-156's update notice), without importing back from
// cli.ts, which imports agentCommands.ts itself.
declare const __HOLODECK_SEA_VERSION__: string | undefined

export function readOwnVersion(): string {
  if (typeof __HOLODECK_SEA_VERSION__ !== 'undefined') {
    return __HOLODECK_SEA_VERSION__
  }
  const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as { version: string }
  return packageJson.version
}
