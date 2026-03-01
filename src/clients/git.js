// Git CLI client.
// When a GitHub token is provided, rewrites URLs to HTTPS with token auth
// and configures commits as the bot identity.

import { execAsync } from './exec.js';
import { TIMEOUTS } from '../defaults.js';

const BOT_NAME = 'warpmetrics[bot]';
const BOT_EMAIL = 'bot@warpmetrics.com';

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

  async function run(args, opts = {}) {
    try {
      const out = await execAsync('git', args, { timeout: TIMEOUTS.GIT, ...opts });
      return out.trim();
    } catch (err) {
      if (token) {
        if (err.message) err.message = err.message.replaceAll(token, '***');
        if (err.stderr) err.stderr = err.stderr.toString().replaceAll(token, '***');
      }
      throw err;
    }
  }

  async function setBotIdentity(dir) {
    if (!token) return;
    await run(['-C', dir, 'config', 'user.name', BOT_NAME]);
    await run(['-C', dir, 'config', 'user.email', BOT_EMAIL]);
  }

  async function clone(repoUrl, dest, { branch } = {}) {
    await run(['clone', ...(branch ? ['--branch', branch] : []), tokenUrl(repoUrl, token), dest]);
    await setBotIdentity(dest);
  }

  async function createBranch(dir, name) {
    await run(['checkout', '-b', name], { cwd: dir });
  }

  async function getHead(dir) {
    return run(['rev-parse', 'HEAD'], { cwd: dir });
  }

  async function hasNewCommits(dir) {
    const count = await run(['rev-list', '--count', 'HEAD', '--not', '--remotes'], { cwd: dir });
    return parseInt(count, 10) > 0;
  }

  async function status(dir) {
    return run(['status', '--short'], { cwd: dir });
  }

  async function commitAll(dir, message, { allowEmpty = false } = {}) {
    await run(['add', '-A'], { cwd: dir });
    await run(['commit', ...(allowEmpty ? ['--allow-empty'] : []), '-m', message], { cwd: dir });
  }

  async function push(dir, branch) {
    await run(['fetch', 'origin'], { cwd: dir });
    await run(['push', '-u', '--force-with-lease', 'origin', branch], { cwd: dir });
  }

  async function getCurrentBranch(dir) {
    return run(['branch', '--show-current'], { cwd: dir });
  }

  return { clone, setBotIdentity, createBranch, getHead, hasNewCommits, status, commitAll, push, getCurrentBranch };
}
