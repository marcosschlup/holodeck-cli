import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { ClaimedExecution } from './executionApi.js'
import { buildRunArguments, buildRunPrompt, createRunSummary, judgeRun } from './headlessRun.js'
import { cleanUpWorktree, isGitRepository, worktreeNameFor } from './worktree.js'

const execution = (trigger: ClaimedExecution['trigger']): ClaimedExecution => ({
  id: 'cmexecution000abc123',
  trigger,
  enqueuedAt: '2026-09-27T12:00:00.000Z',
  startedAt: '2026-09-27T12:00:01.000Z',
  task: { id: 'task-1', displayId: 'TES-12', title: 'Fix the login redirect', projectId: 'project-1' },
})

describe('buildRunPrompt', () => {
  it('names the task and what to do for each trigger', () => {
    assert.match(buildRunPrompt(execution('assignment')), /TES-12 \("Fix the login redirect"\) was assigned to you.*start_working_on_task/)
    assert.match(buildRunPrompt(execution('block_resolved')), /block on Holodeck task TES-12.*get_task_activity/)
    const mentioned = buildRunPrompt({
      ...execution('mention'),
      mentions: [
        { text: '@bot can you check the logs?', authorName: 'Marcos', authorHandle: 'marcosschlup', at: '2026-09-27T12:00:00.000Z' },
        { text: '@bot and the metrics', authorName: null, authorHandle: null, at: '2026-09-27T12:01:00.000Z' },
      ],
    })
    assert.equal(
      mentioned.split('\n').slice(0, 3).join('\n'),
      'You were mentioned in notes on Holodeck task TES-12 ("Fix the login redirect"):\n- Marcos (@marcosschlup) wrote: @bot can you check the logs?\n- Someone wrote: @bot and the metrics',
    )
    assert.match(mentioned, /answer with add_interaction/)
    for (const trigger of ['assignment', 'block_resolved'] as const) {
      assert.match(buildRunPrompt(execution(trigger)), /raise_blocked/)
    }
  })
})

describe('buildRunArguments', () => {
  it('runs in auto mode with prompts denied, and adds worktree, model and effort only when set', () => {
    const bare = buildRunArguments({ mcpConfigPath: 'mcp.json', model: null, effort: null })
    assert.deepEqual(bare, [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'auto',
      '--permission-prompts',
      'none',
      '--no-session-persistence',
      '--mcp-config',
      'mcp.json',
    ])
    const full = buildRunArguments({ mcpConfigPath: 'mcp.json', worktreeName: 'holodeck-tes-12-abc123', model: 'opus', effort: 'high' })
    assert.deepEqual(full.slice(bare.length), ['-w', 'holodeck-tes-12-abc123', '--model', 'opus', '--effort', 'high'])
  })
})

// Shapes from a real Claude Code 2.1.282 stream (the HOL-131 spike), cut down.
const INIT = JSON.stringify({ type: 'system', subtype: 'init', cwd: 'C:\\repo\\.claude\\worktrees\\run', permissionMode: 'auto', tools: ['Bash'] })
const RESULT_OK = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  terminal_reason: 'completed',
  total_cost_usd: 0.216,
  num_turns: 4,
  permission_denials: [],
  result: 'Done.',
})

describe('createRunSummary and judgeRun', () => {
  it('keeps the worktree, the mode and the result, ignoring everything else', () => {
    const { add, summary } = createRunSummary()
    add(INIT)
    add(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'secret' } }] } }))
    add('not json')
    add(RESULT_OK)
    assert.deepEqual(summary, {
      cwd: 'C:\\repo\\.claude\\worktrees\\run',
      permissionMode: 'auto',
      result: { subtype: 'success', isError: false, terminalReason: 'completed', costUsd: 0.216, turns: 4, permissionDenials: 0, text: 'Done.' },
    })
    assert.deepEqual(judgeRun({ exitCode: 0, stderrTail: '' }, summary), { success: true })
  })

  it('explains a failure: exit code, result kind, denials, last message and stderr', () => {
    const { add, summary } = createRunSummary()
    add(
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        terminal_reason: 'max_turns',
        permission_denials: [{ tool_name: 'Write' }],
        result: 'Gave up.',
      }),
    )
    const judged = judgeRun({ exitCode: 1, stderrTail: 'boom' }, summary)
    assert.equal(judged.success, false)
    assert.equal(
      judged.reason,
      'Claude Code exited with code 1; result: error_max_turns (max_turns); 1 permission denial(s); last message: Gave up.; stderr: boom',
    )
  })

  it('calls an API error an error even when its subtype says success', () => {
    const { add, summary } = createRunSummary()
    add(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', permission_denials: [] }))
    assert.match(judgeRun({ exitCode: 1, stderrTail: '' }, summary).reason ?? '', /result: error \(api_error\)/)
  })

  it('fails a clean exit without a result, and a killed process', () => {
    assert.equal(judgeRun({ exitCode: 0, stderrTail: '' }, {}).success, false)
    assert.match(judgeRun({ exitCode: null, stderrTail: '' }, {}).reason ?? '', /^Claude Code was stopped; no result$/)
  })
})

describe('worktree', () => {
  it('names a run after its task and entry', () => {
    assert.equal(worktreeNameFor(execution('assignment')), 'holodeck-tes-12-abc123')
  })

  it('removes a clean worktree and its commit-less branch, keeps a dirty one', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'holodeck-worktree-'))
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.test', ...args], { cwd, stdio: 'pipe' })
    try {
      git(repo, 'init', '-q')
      fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n')
      git(repo, 'add', '.')
      git(repo, 'commit', '-qm', 'init')
      assert.equal(await isGitRepository(repo), true)

      const clean = path.join(repo, '.claude', 'worktrees', 'clean')
      git(repo, 'worktree', 'add', '-q', '-b', 'worktree-clean', clean)
      git(repo, 'worktree', 'lock', clean)
      assert.deepEqual(await cleanUpWorktree(repo, clean), { outcome: 'removed' })
      assert.equal(fs.existsSync(clean), false)
      assert.equal(git(repo, 'branch', '--list', 'worktree-clean').toString().trim(), '')

      const dirty = path.join(repo, '.claude', 'worktrees', 'dirty')
      git(repo, 'worktree', 'add', '-q', '-b', 'worktree-dirty', dirty)
      fs.writeFileSync(path.join(dirty, 'notes.txt'), 'work in progress\n')
      assert.deepEqual(await cleanUpWorktree(repo, dirty), { outcome: 'kept', path: dirty })
      assert.equal(fs.existsSync(dirty), true)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  it('knows a plain folder is not a repository', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'holodeck-plain-'))
    try {
      assert.equal(await isGitRepository(folder), false)
    } finally {
      fs.rmSync(folder, { recursive: true, force: true })
    }
  })
})
