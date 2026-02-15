// Agent pipeline — check if we should attempt another revision.
// Queries WarpMetrics for previous "revise" runs on this PR.
// Sets GitHub Actions outputs: should_revise, revision_count.

import { appendFileSync } from 'fs';
import { findRuns } from './pipeline.js';

const apiKey = process.env.WARPMETRICS_API_KEY;
const prNumber = process.env.PR_NUMBER;
const repo = process.env.GITHUB_REPOSITORY;
const MAX_REVISIONS = 3;

function setOutput(key, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(`${key}=${value}`);
}

if (!apiKey) {
  setOutput('should_revise', 'true');
  setOutput('revision_count', '0');
  process.exit(0);
}

try {
  const runs = await findRuns(apiKey, 'agent-pipeline');
  const revisions = runs.filter(r =>
    r.opts?.step === 'revise' &&
    r.opts?.pr_number === String(prNumber) &&
    r.opts?.repo === repo
  );

  const count = revisions.length;
  const shouldRevise = count < MAX_REVISIONS;

  setOutput('should_revise', String(shouldRevise));
  setOutput('revision_count', String(count));

  console.log(shouldRevise
    ? `Revision ${count + 1}/${MAX_REVISIONS}`
    : `Revision limit reached (${count}/${MAX_REVISIONS})`);
} catch (err) {
  console.warn(`Revision check failed: ${err.message} — allowing revision`);
  setOutput('should_revise', 'true');
  setOutput('revision_count', '0');
}
