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
    { name: 'Merged', classification: 'success' },
    { name: 'Shipped', classification: 'success' },
    { name: 'Issue Understood', classification: 'success' },
    { name: 'Needs Clarification', classification: 'neutral' },
    { name: 'Needs Human', classification: 'neutral' },
    { name: 'Implementation Failed', classification: 'failure' },
    { name: 'Tests Failed', classification: 'failure' },
    { name: 'Revision Failed', classification: 'failure' },
    { name: 'Merge Failed', classification: 'failure' },
    { name: 'Max Retries', classification: 'failure' },
    { name: 'Started', classification: 'neutral' },
    { name: 'Resumed', classification: 'neutral' },
    { name: 'Clarified', classification: 'success' },
    { name: 'Released', classification: 'success' },
    { name: 'Release Failed', classification: 'failure' },
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
// Issue run — the root of the lifecycle chain
// ---------------------------------------------------------------------------

export async function createIssueRun(apiKey, { repo, issueNumber, issueTitle }) {
  const runId = generateId('run');
  const outcomeId = generateId('oc');
  const actId = generateId('act');
  const now = new Date().toISOString();

  await sendEvents(apiKey, {
    runs: [{ id: runId, label: 'Issue', opts: { name: `Issue #${issueNumber}: ${issueTitle}`, repo, issue: String(issueNumber) }, refId: null, startedAt: now }],
    outcomes: [{ id: outcomeId, refId: runId, name: 'Started', opts: null, timestamp: now }],
    acts: [{ id: actId, refId: outcomeId, name: 'Implement', opts: null, timestamp: now }],
  });

  return { runId, actId };
}

export async function closeIssueRun(apiKey, { runId, name, opts }) {
  const outcomeId = generateId('oc');
  const now = new Date().toISOString();
  await sendEvents(apiKey, {
    outcomes: [{ id: outcomeId, refId: runId, name, opts: opts || null, timestamp: now }],
  });
  return { outcomeId };
}

// ---------------------------------------------------------------------------
// Pipeline helpers — start run/group and record outcome
// ---------------------------------------------------------------------------

export async function startPipeline(apiKey, { step, repo, issueNumber, issueTitle, prNumber, refActId }) {
  const runId = generateId('run');
  const groupId = generateId('grp');
  const now = new Date().toISOString();
  const label = step.charAt(0).toUpperCase() + step.slice(1);

  const opts = { repo, step };
  if (issueNumber) opts.issue = String(issueNumber);
  if (issueTitle) opts.title = issueTitle;
  if (prNumber) opts.pr_number = String(prNumber);

  await sendEvents(apiKey, {
    runs: [{ id: runId, label, opts, refId: refActId || null, startedAt: now }],
    groups: [{ id: groupId, label, opts: { triggered_at: now }, startedAt: now }],
    links: [{ parentId: runId, childId: groupId, type: 'group', timestamp: now }],
  });

  return { runId, groupId };
}

export async function recordOutcome(apiKey, { runId, groupId }, { step, success, costUsd, error, hooksFailed, issueNumber, prNumber, reviewCommentCount, name: nameOverride }) {
  const names = {
    implement: { true: 'PR Created', false: 'Implementation Failed' },
    revise: { true: 'Fixes Applied', false: 'Revision Failed' },
    merge: { true: 'Merged', false: 'Merge Failed' },
  };

  const name = nameOverride || names[step]?.[String(success)] || `${step}: ${success ? 'success' : 'failure'}`;
  const now = new Date().toISOString();

  const opts = { status: success ? 'success' : 'failure', step };
  if (costUsd != null) opts.cost_usd = String(costUsd);
  if (error) opts.error = error.slice(0, 500);
  if (hooksFailed) opts.hooks_failed = 'true';
  if (issueNumber) opts.issue = String(issueNumber);
  if (prNumber) opts.pr_number = String(prNumber);
  if (reviewCommentCount) opts.review_comments = String(reviewCommentCount);

  const groupOutcomeId = generateId('oc');
  const outcomes = [
    { id: groupOutcomeId, refId: groupId, name, opts, timestamp: now },
  ];

  let runOutcomeId = null;
  if (runId) {
    runOutcomeId = generateId('oc');
    outcomes.push({ id: runOutcomeId, refId: runId, name, opts, timestamp: now });
  }

  await sendEvents(apiKey, { outcomes });

  return { id: groupOutcomeId, runOutcomeId, name };
}

export async function emitAct(apiKey, { outcomeId, actId, name, opts }) {
  const now = new Date().toISOString();
  await sendEvents(apiKey, {
    acts: [{ id: actId, refId: outcomeId, name, opts: opts || null, timestamp: now }],
  });
}

export async function findIssueRun(apiKey, { repo, issueNumber }) {
  const runs = await findRuns(apiKey, 'Issue');
  const match = runs.find(r =>
    r.opts?.repo === repo &&
    r.opts?.issue === String(issueNumber)
  );
  if (!match) return null;

  const res = await fetch(`${API_URL}/v1/runs/${match.id}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return null;
  const { data } = await res.json();

  const outcomes = data.outcomes || [];
  const lastOutcome = outcomes[outcomes.length - 1];
  const blockedAt = lastOutcome?.name === 'Max Retries' ? lastOutcome.timestamp : null;

  return { runId: match.id, blockedAt, countSince: null };
}

// ---------------------------------------------------------------------------
// Clarification chain: outcome → act → run
// ---------------------------------------------------------------------------

export async function recordClarification(apiKey, { issueRunId, question }) {
  const outcomeId = generateId('oc');
  const actId = generateId('act');
  const clarifyRunId = generateId('run');
  const clarifyGroupId = generateId('grp');
  const now = new Date().toISOString();

  await sendEvents(apiKey, {
    outcomes: [{ id: outcomeId, refId: issueRunId, name: 'Needs Clarification', opts: null, timestamp: now }],
    acts: [{ id: actId, refId: outcomeId, name: 'Ask User', opts: { question: question.slice(0, 500) }, timestamp: now }],
    runs: [{ id: clarifyRunId, label: 'Clarify', opts: null, refId: actId, startedAt: now }],
    groups: [{ id: clarifyGroupId, label: 'Clarify', opts: { triggered_at: now }, startedAt: now }],
    links: [{ parentId: clarifyRunId, childId: clarifyGroupId, type: 'group', timestamp: now }],
  });

  return { clarifyRunId, clarifyGroupId };
}

export async function recordClarified(apiKey, { clarifyRunId, clarifyGroupId }) {
  const outcomeId = generateId('oc');
  const actId = generateId('act');
  const now = new Date().toISOString();

  await sendEvents(apiKey, {
    outcomes: [
      { id: outcomeId, refId: clarifyRunId, name: 'Clarified', opts: null, timestamp: now },
      { id: generateId('oc'), refId: clarifyGroupId, name: 'Clarified', opts: null, timestamp: now },
    ],
    acts: [{ id: actId, refId: outcomeId, name: 'Implement', opts: null, timestamp: now }],
  });

  return { actId };
}

// ---------------------------------------------------------------------------
// Release pipeline
// ---------------------------------------------------------------------------

/**
 * Start a Release run, linked to a Release act created at ship time.
 * Returns { runId } for the Release run.
 */
export async function startReleaseRun(apiKey, { refActId, repos }) {
  const runId = generateId('run');
  const now = new Date().toISOString();

  await sendEvents(apiKey, {
    runs: [{ id: runId, label: 'Release', opts: { repos: repos.join(',') }, refId: refActId || null, startedAt: now }],
  });

  return { runId };
}

/**
 * Create a group within a run (for per-repo release steps).
 */
export async function createGroup(apiKey, { runId, label, opts }) {
  const groupId = generateId('grp');
  const now = new Date().toISOString();

  await sendEvents(apiKey, {
    groups: [{ id: groupId, label, opts: opts || null, startedAt: now }],
    links: [{ parentId: runId, childId: groupId, type: 'group', timestamp: now }],
  });

  return { groupId };
}

// ---------------------------------------------------------------------------
// Release queries
// ---------------------------------------------------------------------------

export async function findShippedIssues(apiKey) {
  const runs = await findRuns(apiKey, 'Issue', { limit: 100 });
  const shipped = [];

  // Fetch all Release acts to match against outcomes
  const releaseActs = await findActs(apiKey, 'Release');
  const actsByOutcomeId = new Map();
  for (const act of releaseActs) {
    actsByOutcomeId.set(act.refId, act);
  }

  for (const run of runs) {
    const res = await fetch(`${API_URL}/v1/runs/${run.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) continue;
    const { data } = await res.json();

    const outcomes = data.outcomes || [];
    if (outcomes.length === 0) continue;

    const lastOutcome = outcomes[outcomes.length - 1];
    if (lastOutcome.name === 'Shipped' || lastOutcome.name === 'Release Failed') {
      // Find the Shipped outcome (may not be last if Release Failed followed it)
      const shippedOutcome = [...outcomes].reverse().find(o => o.name === 'Shipped');
      if (!shippedOutcome) continue;

      // Find the Release act on the Shipped outcome
      const releaseAct = actsByOutcomeId.get(shippedOutcome.id);

      shipped.push({
        runId: run.id,
        opts: run.opts,
        shippedOutcome,
        releaseActId: releaseAct?.id || null,
      });
    }
  }

  return shipped;
}

async function findActs(apiKey, name) {
  const params = new URLSearchParams({ name, limit: '100' });
  const res = await fetch(`${API_URL}/v1/acts?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.data || [];
}

export async function countRevisions(apiKey, { prNumber, repo, since }) {
  try {
    const runs = await findRuns(apiKey, 'Revise');
    return runs.filter(r =>
      r.opts?.pr_number === String(prNumber) &&
      r.opts?.repo === repo &&
      (!since || new Date(r.createdAt) >= new Date(since))
    ).length;
  } catch {
    return 0;
  }
}
