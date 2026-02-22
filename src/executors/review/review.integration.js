// Integration test for the review executor.
// Spins up real git repos, spawns Claude Code, verifies the full flow.
//
// Run:  npm run test:integration
// Requires: `claude` CLI on PATH
// Cost: ~$0.05-0.15 per run

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { review } from './index.js';
import { createClaudeCodeClient } from '../../clients/claude-code.js';

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 15_000, ...opts }).trim();
}

// ---------------------------------------------------------------------------
// Test fixtures — real git repos
// ---------------------------------------------------------------------------

const ISSUE_ID = 77777;
const BRANCH = `agent/issue-${ISSUE_ID}`;
const BASE = join(tmpdir(), `warp-review-integration-${Date.now()}`);
const BARE_REPO = join(BASE, 'bare.git');
const SRC_REPO = join(BASE, 'src-repo');
const WORKDIR = join(tmpdir(), 'warp-coder', String(ISSUE_ID));

function setupGitRepos() {
  mkdirSync(BASE, { recursive: true });

  // 1. Bare repo (acts as "remote")
  git(['init', '--bare', BARE_REPO]);

  // 2. Source repo — initial commit on main
  mkdirSync(join(SRC_REPO, 'src'), { recursive: true });
  git(['init'], { cwd: SRC_REPO });
  git(['config', 'user.email', 'test@warp.dev'], { cwd: SRC_REPO });
  git(['config', 'user.name', 'Test'], { cwd: SRC_REPO });
  git(['remote', 'add', 'origin', BARE_REPO], { cwd: SRC_REPO });

  writeFileSync(join(SRC_REPO, 'src', 'auth.js'), [
    'export function login(username, password) {',
    '  const user = db.findUser(username);',
    '  if (user.password === password) {',
    '    return { token: generateToken(user) };',
    '  }',
    '  return null;',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(SRC_REPO, 'package.json'), JSON.stringify({ name: 'test-app', version: '1.0.0' }));
  git(['add', '.'], { cwd: SRC_REPO });
  git(['commit', '-m', 'initial commit'], { cwd: SRC_REPO });
  git(['push', 'origin', 'HEAD:main'], { cwd: SRC_REPO });

  // 3. Feature branch — fix the auth code
  git(['checkout', '-b', BRANCH], { cwd: SRC_REPO });

  writeFileSync(join(SRC_REPO, 'src', 'auth.js'), [
    'import { hash } from \'./crypto.js\';',
    '',
    'export function login(username, password) {',
    '  if (!username || !password) {',
    '    throw new Error(\'Username and password are required\');',
    '  }',
    '  const user = db.findUser(username);',
    '  if (!user) return null;',
    '  if (user.password === hash(password)) {',
    '    return { token: generateToken(user) };',
    '  }',
    '  return null;',
    '}',
    '',
  ].join('\n'));

  git(['add', '.'], { cwd: SRC_REPO });
  git(['commit', '-m', 'fix: add input validation and password hashing'], { cwd: SRC_REPO });
  git(['push', 'origin', BRANCH], { cwd: SRC_REPO });
}

// ---------------------------------------------------------------------------
// Test clients — real clone, real Claude, captured submitReview
// ---------------------------------------------------------------------------

function createTestGit() {
  return {
    clone: (url, dest, opts) => {
      git(['clone', '-b', opts.branch, url, dest]);
    },
  };
}

function createTestPRs() {
  const submitted = [];
  const repoId = BARE_REPO.replace(/\.git$/, '');

  return {
    findAllPRs: () => [{ repo: repoId, prNumber: 1 }],
    getPRBranch: () => BRANCH,
    submitReview: (prNumber, opts) => {
      submitted.push({ prNumber, ...opts });
    },
    _submitted: submitted,
  };
}

function createTestIssues() {
  return {
    getIssueBody: () => [
      'The login function in `src/auth.js` has several issues:',
      '1. No input validation — crashes if username/password are missing',
      '2. Passwords are compared in plain text instead of using hashed comparison',
      '3. No null check on user lookup — `db.findUser` can return null',
    ].join('\n'),
    getIssueComments: () => [
      { user: { login: 'alice' }, body: 'This is a security issue, please prioritize' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('review executor (integration)', { timeout: 180_000 }, () => {

  before(() => {
    // Check claude is available
    try {
      execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
    } catch {
      throw new Error('claude CLI not found on PATH — required for integration tests');
    }

    // Clean previous runs
    try { rmSync(BASE, { recursive: true, force: true }); } catch {}
    try { rmSync(WORKDIR, { recursive: true, force: true }); } catch {}

    setupGitRepos();
  });

  after(() => {
    try { rmSync(BASE, { recursive: true, force: true }); } catch {}
    try { rmSync(WORKDIR, { recursive: true, force: true }); } catch {}
  });

  it('reviews a PR end-to-end: clone, review, parse verdict, submit review', async () => {
    const gitClient = createTestGit();
    const prs = createTestPRs();
    const issues = createTestIssues();
    const claudeCode = createClaudeCodeClient({ warp: { traceClaudeCall: () => {} }, config: {} });
    const logs = [];
    const steps = [];

    const repoId = BARE_REPO.replace(/\.git$/, '');
    const config = {
      repos: [{ url: BARE_REPO }],
      repoNames: [repoId],
      claude: { reviewMaxTurns: 10 },
    };

    const result = await review(
      { _issueId: ISSUE_ID, content: { title: 'Fix auth input validation and password hashing' } },
      {
        config,
        clients: { git: gitClient, prs, issues, claudeCode, log: msg => { logs.push(msg); process.stderr.write(`  ${msg}\n`); } },
        context: {
          onStep: step => steps.push(step),
          onBeforeLog: () => {},
        },
      },
    );

    // --- Result structure ---
    assert.ok(['approved', 'changes_requested'].includes(result.type),
      `expected approved or changes_requested, got: ${result.type} (error: ${result.error || 'none'})`);
    assert.ok(result.costUsd > 0, 'should report cost');
    assert.ok(result.trace, 'should include trace');
    assert.equal(result.prNumber, 1);
    assert.ok(Array.isArray(result.prs));
    assert.equal(result.prs.length, 1);
    assert.equal(typeof result.commentCount, 'number');

    // --- Steps executed in order ---
    assert.ok(steps.includes('finding PRs'), 'should find PRs');
    assert.ok(steps.includes('cloning'), 'should clone');
    assert.ok(steps.includes('reviewing'), 'should review');
    assert.ok(steps.includes('submitting review'), 'should submit review');

    // --- Review was submitted to PR client ---
    assert.equal(prs._submitted.length, 1, 'should submit exactly one review');
    const sub = prs._submitted[0];
    assert.equal(sub.prNumber, 1);
    assert.ok(['APPROVE', 'REQUEST_CHANGES'].includes(sub.event));
    assert.ok(sub.body.length > 0, 'review body should be non-empty');

    // --- Logs show progress ---
    assert.ok(logs.some(l => l.includes('found 1 PR')), 'should log PR discovery');
    assert.ok(logs.some(l => l.includes('claude done')), 'should log claude completion');
    assert.ok(logs.some(l => l.includes('submitted')), 'should log review submission');

    // --- Report ---
    process.stderr.write(`\n  verdict: ${result.type}\n`);
    process.stderr.write(`  cost: $${result.costUsd}\n`);
    process.stderr.write(`  comments: ${result.commentCount}\n`);
    if (sub.comments?.length) {
      for (const c of sub.comments) {
        process.stderr.write(`    ${c.path}:${c.line || '?'} — ${c.body.slice(0, 80)}\n`);
      }
    }
  });
});
