// Git CLI client.
// When a GitHub token is provided, rewrites URLs to HTTPS with token auth
// and configures commits as the bot identity.

import { execFileSync } from 'child_process';

const BOT_NAME = 'warpmetrics[bot]';
const BOT_EMAIL = 'bot@warpmetrics.com';

function run(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

/**
 * Rewrite any GitHub URL to HTTPS with embedded token.
 * Handles: git@github.com:org/repo.git, https://github.com/org/repo.git
 */
export function tokenUrl(url, token) {
  if (!token) return url;
  const match = url.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (!match) return url;
  return `https://x-access-token:${token}@github.com/${match[1]}.git`;
}

export function createGitClient({ token } = {}) {

  function setBotIdentity(dir) {
    if (!token) return;
    run(['-C', dir, 'config', 'user.name', BOT_NAME]);
    run(['-C', dir, 'config', 'user.email', BOT_EMAIL]);
  }

  function clone(repoUrl, dest, { branch } = {}) {
    run(['clone', ...(branch ? ['--branch', branch] : []), tokenUrl(repoUrl, token), dest]);
    setBotIdentity(dest);
  }

  function createBranch(dir, name) {
    run(['checkout', '-b', name], { cwd: dir });
  }

  function getHead(dir) {
    return run(['rev-parse', 'HEAD'], { cwd: dir });
  }

  function hasNewCommits(dir) {
    const count = run(['rev-list', '--count', 'HEAD', '--not', '--remotes'], { cwd: dir });
    return parseInt(count, 10) > 0;
  }

  function status(dir) {
    return run(['status', '--short'], { cwd: dir });
  }

  function commitAll(dir, message, { allowEmpty = false } = {}) {
    run(['add', '-A'], { cwd: dir });
    run(['commit', ...(allowEmpty ? ['--allow-empty'] : []), '-m', message], { cwd: dir });
  }

  function push(dir, branch) {
    run(['fetch', 'origin'], { cwd: dir });
    run(['push', '-u', '--force-with-lease', 'origin', branch], { cwd: dir });
  }

  function getCurrentBranch(dir) {
    return run(['branch', '--show-current'], { cwd: dir });
  }

  return { clone, setBotIdentity, createBranch, getHead, hasNewCommits, status, commitAll, push, getCurrentBranch };
}
