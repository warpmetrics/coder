// Integration test for the implement executor.
// Verifies that Claude Code runs, creates changes, and populates the deploy plan (release array).
//
// Run:  npm run test:integration
// Requires: `claude` CLI on PATH
// Cost: ~$0.10-0.30 per run

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { implement } from './index.js';
import { repoName } from '../../config.js';

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', timeout: 15_000, ...opts }).trim();
}

// ---------------------------------------------------------------------------
// Test fixtures — real git repos
// ---------------------------------------------------------------------------

const ISSUE_ID = 88888;
const BASE = join(tmpdir(), `warp-impl-integration-${Date.now()}`);
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

  writeFileSync(join(SRC_REPO, 'src', 'math.js'), [
    'export function add(a, b) {',
    '  return a + b;',
    '}',
    '',
    'export function subtract(a, b) {',
    '  return a - b;',
    '}',
    '',
  ].join('\n'));

  writeFileSync(join(SRC_REPO, 'package.json'), JSON.stringify({ name: 'test-app', version: '1.0.0' }));
  git(['add', '.'], { cwd: SRC_REPO });
  git(['commit', '-m', 'initial commit'], { cwd: SRC_REPO });
  git(['push', 'origin', 'HEAD:main'], { cwd: SRC_REPO });
}

// ---------------------------------------------------------------------------
// Test clients — real git operations, mock PR/issue APIs
// ---------------------------------------------------------------------------

function createTestGit() {
  return {
    clone: (url, dest) => { git(['clone', url, dest]); },
    createBranch: (dir, branch) => { git(['checkout', '-b', branch], { cwd: dir }); },
    status: (dir) => {
      const out = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim();
      return out.length > 0;
    },
    commitAll: (dir, message) => {
      git(['add', '-A'], { cwd: dir });
      git(['commit', '-m', message], { cwd: dir });
    },
    getCurrentBranch: (dir) => git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }),
    hasNewCommits: (dir) => {
      try {
        const out = git(['log', 'origin/main..HEAD', '--oneline'], { cwd: dir });
        return out.length > 0;
      } catch { return true; }
    },
    push: (dir, branch) => { git(['push', 'origin', branch], { cwd: dir }); },
  };
}

function createTestPRs() {
  const created = [];
  return {
    createPR: (dir, { title, body, head }) => {
      const pr = { number: created.length + 1, url: `file://${dir}/pull/${created.length + 1}` };
      created.push({ dir, title, body, head, ...pr });
      return pr;
    },
    _created: created,
  };
}

function createTestIssues() {
  return {
    getIssueComments: () => [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('implement executor (integration)', { timeout: 180_000 }, () => {
  const REPO_OBJ = { url: BARE_REPO };
  let REPO_NAME;

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
    REPO_NAME = repoName(REPO_OBJ);
  });

  after(() => {
    try { rmSync(BASE, { recursive: true, force: true }); } catch {}
    try { rmSync(WORKDIR, { recursive: true, force: true }); } catch {}
  });

  it('implements an issue and populates release in deployPlan', async () => {
    const gitClient = createTestGit();
    const prsClient = createTestPRs();
    const issues = createTestIssues();
    const logs = [];
    const steps = [];

    const config = {
      repos: [REPO_OBJ],
      repoNames: [REPO_NAME],
      deploy: { [REPO_NAME]: { command: 'npm run deploy:prod' } },
      claude: { maxTurns: 15 },
      memory: { enabled: false },
    };

    const result = await implement(
      { _issueId: ISSUE_ID, content: { title: 'Add a multiply function to math.js', body: 'Add an `export function multiply(a, b)` to `src/math.js` that returns `a * b`.' } },
      {
        config,
        git: gitClient,
        prs: prsClient,
        issues,
        log: msg => { logs.push(msg); process.stderr.write(`  ${msg}\n`); },
        onStep: step => steps.push(step),
        repoNames: [REPO_NAME],
      },
    );

    // --- Result structure ---
    assert.equal(result.type, 'success',
      `expected success, got: ${result.type} (error: ${result.error || 'none'})`);
    assert.ok(result.costUsd > 0, 'should report cost');
    assert.ok(result.trace, 'should include trace');
    assert.ok(result.sessionId, 'should include sessionId');

    // --- PRs created ---
    assert.ok(Array.isArray(result.prs), 'should have prs array');
    assert.ok(result.prs.length >= 1, 'should have created at least one PR');
    assert.equal(result.prs[0].repo, REPO_NAME);
    assert.equal(typeof result.prs[0].prNumber, 'number');

    // --- Deploy plan populated (this is the critical assertion) ---
    assert.ok(result.deployPlan, 'deployPlan should not be null');
    assert.ok(Array.isArray(result.deployPlan.release), 'deployPlan.release should be an array');
    assert.ok(result.deployPlan.release.length >= 1, 'release should have at least one step');

    const step = result.deployPlan.release[0];
    assert.equal(step.repo, REPO_NAME, 'release step repo should match');
    assert.equal(step.command, 'npm run deploy:prod', 'release step command should come from config');
    assert.ok(Array.isArray(step.dependsOn), 'release step should have dependsOn array');

    // --- Logs ---
    assert.ok(logs.some(l => l.includes('claude done')), 'should log claude completion');

    // --- Report ---
    process.stderr.write(`\n  result: ${result.type}\n`);
    process.stderr.write(`  cost: $${result.costUsd}\n`);
    process.stderr.write(`  PRs: ${result.prs.map(p => `${p.repo}#${p.prNumber}`).join(', ')}\n`);
    process.stderr.write(`  release: ${JSON.stringify(result.deployPlan?.release)}\n`);
  });
});
