import envPaths from 'env-paths'

// Native per-OS locations (env-paths — same package Yarn/npm-adjacent
// tooling uses for this), not a hand-rolled `~/.holodeck` dotfile. That
// matters regardless of where the user happens to run the `holodeck`
// binary from (Desktop, a USB stick, wherever) — this is keyed off the
// logged-in user and the OS's own convention, never off process.cwd() or
// the executable's own folder, which the user has no reason to expect
// config/state files to show up in.
//
// No `-nodejs` suffix (env-paths' own default, meant to avoid clashing
// with unrelated native apps sharing a generic name) — "holodeck" is
// specific enough, and the suffix would otherwise leak an implementation
// detail (this happens to be a Node process today) into a path a user
// might actually go looking at.
const paths = envPaths('holodeck', { suffix: '' })

// PID file, IPC socket (POSIX) — local, machine-specific runtime state,
// never meant to sync/roam. (Windows named pipes don't touch the
// filesystem, so nothing here is ever created on Windows, but the
// directory itself is still resolved consistently for the pieces that do
// use it, like the PID file.)
export const dataDir = paths.data

// Where a registered persona's token will be persisted (HOL-53) — kept as
// its own directory rather than reusing dataDir, since it holds
// credentials and the two are backed up/synced under different
// expectations on some setups (e.g. a user's config directory syncing
// via dotfile-manager tooling, their data directory not).
export const configDir = paths.config
