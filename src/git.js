import { execSync } from 'child_process';

function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

export function cloneRepo(repoUrl, dest) {
  run(`git clone --depth 1 ${repoUrl} ${dest}`);
}

export function checkoutBranch(dir, branch) {
  run(`git checkout ${branch}`, { cwd: dir });
}

export function createBranch(dir, name) {
  run(`git checkout -b ${name}`, { cwd: dir });
}

export function push(dir, branch) {
  run(`git push -u origin ${branch}`, { cwd: dir });
}

export function createPR(dir, { title, body, base = 'main' }) {
  const out = run(`gh pr create --title ${JSON.stringify(title)} --body ${JSON.stringify(body)} --base ${base}`, { cwd: dir });
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

export function getPRBranch(prNumber, { repo }) {
  const out = run(`gh pr view ${prNumber} --repo ${repo} --json headRefName --jq .headRefName`);
  return out;
}
