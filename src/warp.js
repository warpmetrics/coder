// WarpMetrics instrumentation client.
// Zero external dependencies — uses Node built-ins + global fetch.

import crypto from 'crypto';

const API_URL = 'https://api.warpmetrics.com';

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generateId(prefix) {
  const t = Date.now().toString(36).padStart(10, '0');
  const r = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `wm_${prefix}_${t}${r}`;
}

// ---------------------------------------------------------------------------
// Events API (same wire format as @warpmetrics/warp)
// ---------------------------------------------------------------------------

export async function sendEvents(apiKey, batch) {
  const full = {
    runs: batch.runs || [],
    groups: batch.groups || [],
    calls: batch.calls || [],
    links: batch.links || [],
    outcomes: batch.outcomes || [],
    acts: batch.acts || [],
  };

  const raw = JSON.stringify(full);
  const body = JSON.stringify({ d: Buffer.from(raw, 'utf-8').toString('base64') });

  const res = await fetch(`${API_URL}/v1/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Events API ${res.status}: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Query API
// ---------------------------------------------------------------------------

export async function findRuns(apiKey, label, { limit = 20 } = {}) {
  const params = new URLSearchParams({ label, limit: String(limit) });
  const res = await fetch(`${API_URL}/v1/runs?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.data || [];
}

// ---------------------------------------------------------------------------
// Outcome classifications (idempotent PUT)
// ---------------------------------------------------------------------------

export async function registerClassifications(apiKey) {
  const items = [
    { name: 'PR Created', classification: 'success' },
    { name: 'Fixes Applied', classification: 'success' },
    { name: 'Issue Understood', classification: 'success' },
    { name: 'Needs Clarification', classification: 'neutral' },
    { name: 'Needs Human', classification: 'neutral' },
    { name: 'Implementation Failed', classification: 'failure' },
    { name: 'Tests Failed', classification: 'failure' },
    { name: 'Revision Failed', classification: 'failure' },
    { name: 'Max Retries', classification: 'failure' },
  ];

  for (const { name, classification } of items) {
    try {
      await fetch(`${API_URL}/v1/outcomes/classifications/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ classification }),
      });
    } catch {
      // Best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Pipeline helpers — start run/group and record outcome
// ---------------------------------------------------------------------------

export async function startPipeline(apiKey, { step, repo, issueNumber, issueTitle, prNumber }) {
  const runId = generateId('run');
  const groupId = generateId('grp');
  const now = new Date().toISOString();

  const opts = { repo, step };
  if (issueNumber) opts.issue = String(issueNumber);
  if (issueTitle) opts.title = issueTitle;
  if (prNumber) opts.pr_number = String(prNumber);

  await sendEvents(apiKey, {
    runs: [{ id: runId, label: 'agent-pipeline', opts, refId: null, timestamp: now }],
    groups: [{ id: groupId, label: step, opts: { triggered_at: now }, timestamp: now }],
    links: [{ parentId: runId, childId: groupId, type: 'group', timestamp: now }],
  });

  return { runId, groupId };
}

export async function recordOutcome(apiKey, groupId, { step, success, costUsd, error, hooksFailed, issueNumber, prNumber, reviewCommentCount }) {
  const names = {
    implement: { true: 'PR Created', false: 'Implementation Failed' },
    revise: { true: 'Fixes Applied', false: 'Revision Failed' },
  };

  const name = names[step]?.[String(success)] || `${step}: ${success ? 'success' : 'failure'}`;
  const id = generateId('oc');
  const now = new Date().toISOString();

  const opts = { status: success ? 'success' : 'failure', step };
  if (costUsd != null) opts.cost_usd = String(costUsd);
  if (error) opts.error = error.slice(0, 500);
  if (hooksFailed) opts.hooks_failed = 'true';
  if (issueNumber) opts.issue = String(issueNumber);
  if (prNumber) opts.pr_number = String(prNumber);
  if (reviewCommentCount) opts.review_comments = String(reviewCommentCount);

  await sendEvents(apiKey, {
    outcomes: [{ id, refId: groupId, name, opts, timestamp: now }],
  });

  return { id, name };
}

export async function countRevisions(apiKey, { prNumber, repo }) {
  try {
    const runs = await findRuns(apiKey, 'agent-pipeline');
    return runs.filter(r =>
      r.opts?.step === 'revise' &&
      r.opts?.pr_number === String(prNumber) &&
      r.opts?.repo === repo
    ).length;
  } catch {
    return 0;
  }
}
