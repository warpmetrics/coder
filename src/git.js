import { execSync } from 'child_process';

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

export function cloneRepo(repoUrl, dest, { branch } = {}) {
  const branchFlag = branch ? ` --branch ${branch}` : '';
  run(`git clone --depth 1${branchFlag} ${repoUrl} ${dest}`);
}

export function checkoutBranch(dir, branch) {
  run(`git checkout ${branch}`, { cwd: dir });
}

export function createBranch(dir, name) {
  run(`git checkout -b ${name}`, { cwd: dir });
}

export function getHead(dir) {
  return run(`git rev-parse HEAD`, { cwd: dir });
}

export function hasNewCommits(dir, base = 'main') {
  const log = run(`git log ${base}..HEAD --oneline`, { cwd: dir });
  return log.length > 0;
}

export function status(dir) {
  return run(`git status --short`, { cwd: dir });
}

export function commitAll(dir, message) {
  run(`git add -A`, { cwd: dir });
  run(`git commit -m ${JSON.stringify(message)}`, { cwd: dir });
}

export function push(dir, branch) {
  run(`git push -u origin ${branch}`, { cwd: dir });
}

export function createPR(dir, { title, body, base = 'main', head }) {
  const headFlag = head ? ` --head ${head}` : '';
  const out = run(`gh pr create --title ${JSON.stringify(title)} --body ${JSON.stringify(body)} --base ${base}${headFlag}`, { cwd: dir });
  // gh pr create prints the PR URL as the last line
  const lines = out.split('\n');
  const url = lines[lines.length - 1];
  const match = url.match(/\/pull\/(\d+)/);
  return { url, number: match ? parseInt(match[1], 10) : null };
}

export function mergePR(prNumber, { repo }) {
  run(`gh pr merge ${prNumber} --squash --delete-branch --repo ${repo}`);
}

export function getReviews(prNumber, { repo }) {
  const out = run(`gh api repos/${repo}/pulls/${prNumber}/reviews`);
  return JSON.parse(out);
}

export function getReviewComments(prNumber, { repo }) {
  const out = run(`gh api repos/${repo}/pulls/${prNumber}/comments`);
  return JSON.parse(out);
}

export function dismissReview(prNumber, reviewId, { repo, message }) {
  run(`gh api repos/${repo}/pulls/${prNumber}/reviews/${reviewId}/dismissals -X PUT -f message=${JSON.stringify(message)}`);
}

export function updatePRBody(prNumber, { repo, body }) {
  run(`gh pr edit ${prNumber} --repo ${repo} --body ${JSON.stringify(body)}`);
}

export function getPRBody(prNumber, { repo }) {
  return run(`gh pr view ${prNumber} --repo ${repo} --json body --jq .body`);
}

export function getPRBranch(prNumber, { repo }) {
  const out = run(`gh pr view ${prNumber} --repo ${repo} --json headRefName --jq .headRefName`);
  return out;
}
