// Agent pipeline — create a WarpMetrics run + group before the agent step.

import { generateId, sendEvents, registerClassifications, saveState } from './pipeline.js';

const apiKey = process.env.WARPMETRICS_API_KEY;
const repo = process.env.GITHUB_REPOSITORY;
const step = process.env.STEP; // "implement" or "revise"
const issueNumber = process.env.ISSUE_NUMBER || null;
const issueTitle = process.env.ISSUE_TITLE || null;
const prNumber = process.env.PR_NUMBER || null;

if (!apiKey) {
  console.log('WARPMETRICS_API_KEY not set — skipping');
  process.exit(0);
}

const runId = generateId('run');
const groupId = generateId('grp');
const now = new Date().toISOString();

const opts = { repo, step };
if (issueNumber) opts.issue = issueNumber;
if (issueTitle) opts.title = issueTitle;
if (prNumber) opts.pr_number = prNumber;

try {
  await sendEvents(apiKey, {
    runs: [{ id: runId, label: 'agent-pipeline', opts, refId: null, timestamp: now }],
    groups: [{ id: groupId, label: step, opts: { triggered_at: now }, timestamp: now }],
    links: [{ parentId: runId, childId: groupId, type: 'group', timestamp: now }],
  });
  console.log(`Pipeline run=${runId} group=${groupId} step=${step}`);
} catch (err) {
  console.warn(`Failed to start pipeline: ${err.message}`);
}

saveState({ runId, groupId, step });

// Register outcome classifications on first run (idempotent)
await registerClassifications(apiKey).catch(() => {});
