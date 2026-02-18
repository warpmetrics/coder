import { execFileSync } from 'child_process';

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

function gh(args, opts = {}) {
  return execFileSync('gh', args, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

export function cloneRepo(repoUrl, dest, { branch } = {}) {
  git(['clone', ...(branch ? ['--branch', branch] : []), repoUrl, dest]);
}

export function createBranch(dir, name) {
  git(['checkout', '-b', name], { cwd: dir });
}

export function getHead(dir) {
  return git(['rev-parse', 'HEAD'], { cwd: dir });
}

export function hasNewCommits(dir) {
  const count = git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], { cwd: dir });
  return parseInt(count, 10) > 0;
}

export function status(dir) {
  return git(['status', '--short'], { cwd: dir });
}

export function commitAll(dir, message, { allowEmpty = false } = {}) {
  git(['add', '-A'], { cwd: dir });
  git(['commit', ...(allowEmpty ? ['--allow-empty'] : []), '-m', message], { cwd: dir });
}

export function push(dir, branch) {
  git(['push', '-u', '--force-with-lease', 'origin', branch], { cwd: dir });
}

export function createPR(dir, { title, body, base, head }) {
  const args = ['pr', 'create', '--title', title, '--body-file', '-'];
  if (base) args.push('--base', base);
  if (head) args.push('--head', head);
  const out = gh(args, { cwd: dir, input: body });
  const lines = out.split('\n');
  const url = lines[lines.length - 1];
  const match = url.match(/\/pull\/(\d+)/);
  return { url, number: match ? parseInt(match[1], 10) : null };
}

export function mergePR(prNumber, { repo }) {
  gh(['pr', 'merge', String(prNumber), '--squash', '--delete-branch', '--repo', repo]);
}

export function getReviews(prNumber, { repo }) {
  const out = gh(['api', `repos/${repo}/pulls/${prNumber}/reviews`]);
  return JSON.parse(out);
}

export function getReviewComments(prNumber, { repo }) {
  const out = gh(['api', `repos/${repo}/pulls/${prNumber}/comments`]);
  return JSON.parse(out);
}

export function dismissReview(prNumber, reviewId, { repo, message }) {
  gh(['api', `repos/${repo}/pulls/${prNumber}/reviews/${reviewId}/dismissals`, '-X', 'PUT', '-f', `message=${message}`]);
}

export function updatePRBody(prNumber, { repo, body }) {
  gh(['pr', 'edit', String(prNumber), '--repo', repo, '--body-file', '-'], { input: body });
}

export function getPRBody(prNumber, { repo }) {
  return gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'body', '--jq', '.body']);
}

export function getPRBranch(prNumber, { repo }) {
  return gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'headRefName', '--jq', '.headRefName']);
}

export function getPRState(prNumber, { repo }) {
  return gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state', '--jq', '.state']);
}

export function getCurrentBranch(dir) {
  return git(['branch', '--show-current'], { cwd: dir });
}

export function getPRFiles(prNumber, { repo }) {
  const out = gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'files', '--jq', '.files']);
  return JSON.parse(out);
}

export function getPRCommits(prNumber, { repo }) {
  const out = gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'commits', '--jq', '.commits']);
  return JSON.parse(out);
}

export function getIssueComments(issueId, { repo }) {
  const out = gh(['api', `repos/${repo}/issues/${issueId}/comments`, '--paginate']);
  return JSON.parse(out);
}

export function commentOnIssue(issueId, { repo, body }) {
  gh(['issue', 'comment', String(issueId), '--repo', repo, '--body-file', '-'], { input: body });
}

export function botComment(issueId, { repo, body, runId }) {
  const header = runId
    ? `**warp-coder** · [run](https://warpmetrics.com/app/runs/${runId})`
    : '**warp-coder**';
  const formatted = `${header}\n\n---\n\n${body}`;
  commentOnIssue(issueId, { repo, body: formatted });
}
