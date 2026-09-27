import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ClaimedExecution } from './executionApi.js'

// The git side of Headless runs (HOL-131). Each run in a git repository gets
// its own worktree through Claude Code's `-w` (headlessRun.ts); Claude Code
// leaves it behind when the process ends, so this cleans it up.
//
// Rule (decided with Marcos): a worktree with nothing uncommitted is removed,
// and so is its branch when the run made no commits of its own (`git branch -d`
// refuses a branch with unmerged commits, which is exactly the check wanted).
// A worktree with uncommitted changes is kept for a person to look at, and the
// run record says where.

const exec = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true })
  return stdout.trim()
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true'
  } catch {
    return false
  }
}

// `holodeck-tes-12-3f9a1c`: readable in `git worktree list`, unique per run.
export function worktreeNameFor(execution: ClaimedExecution): string {
  const display = execution.task.displayId.toLowerCase().replace(/[^a-z0-9-]+/g, '-')
  return `holodeck-${display}-${execution.id.slice(-6)}`
}

export type WorktreeCleanup = { outcome: 'removed' } | { outcome: 'kept'; path: string } | { outcome: 'failed'; path: string; error: string }

export async function cleanUpWorktree(repositoryCwd: string, worktreePath: string): Promise<WorktreeCleanup> {
  try {
    if ((await git(worktreePath, ['status', '--porcelain'])) !== '') {
      return { outcome: 'kept', path: worktreePath }
    }
    const branch = await git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    // Twice `--force`: Claude Code leaves the worktree locked.
    await git(repositoryCwd, ['worktree', 'remove', '--force', '--force', path.resolve(worktreePath)])
    if (branch !== 'HEAD') {
      await git(repositoryCwd, ['branch', '-d', branch]).catch(() => {})
    }
    return { outcome: 'removed' }
  } catch (error) {
    return { outcome: 'failed', path: worktreePath, error: error instanceof Error ? error.message : String(error) }
  }
}
