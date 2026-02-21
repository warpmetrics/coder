// Stateless git CLI functions.
// These never vary by provider — git is always git.

import { execFileSync } from 'child_process';

function run(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

export function clone(repoUrl, dest, { branch } = {}) {
  run(['clone', ...(branch ? ['--branch', branch] : []), repoUrl, dest]);
}

export function createBranch(dir, name) {
  run(['checkout', '-b', name], { cwd: dir });
}

export function getHead(dir) {
  return run(['rev-parse', 'HEAD'], { cwd: dir });
}

export function hasNewCommits(dir) {
  const count = run(['rev-list', '--count', 'HEAD', '--not', '--remotes'], { cwd: dir });
  return parseInt(count, 10) > 0;
}

export function status(dir) {
  return run(['status', '--short'], { cwd: dir });
}

export function commitAll(dir, message, { allowEmpty = false } = {}) {
  run(['add', '-A'], { cwd: dir });
  run(['commit', ...(allowEmpty ? ['--allow-empty'] : []), '-m', message], { cwd: dir });
}

export function push(dir, branch) {
  run(['push', '-u', '--force-with-lease', 'origin', branch], { cwd: dir });
}

export function getCurrentBranch(dir) {
  return run(['branch', '--show-current'], { cwd: dir });
}
