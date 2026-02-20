// WarpMetrics state layer.
// Uses @warpmetrics/warp SDK for writes, direct API for reads.

import crypto from 'crypto';
import {
  warp as warpInit,
  run as sdkRun,
  group as sdkGroup,
  outcome as sdkOutcome,
  act as sdkAct,
  trace as sdkTrace,
  flush as sdkFlush,
  reserve as sdkReserve,
} from '@warpmetrics/warp';
import { OUTCOMES, ACTS, LABELS, CLASSIFICATIONS, VERSION } from '../names.js';

const API_URL = 'https://api.warpmetrics.com';

// ---------------------------------------------------------------------------
// SDK initialization (lazy, idempotent)
// ---------------------------------------------------------------------------

let sdkReady = false;

function ensureSDK(apiKey) {
  if (!sdkReady) {
    warpInit(null, { apiKey });
    sdkReady = true;
  }
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generateId(prefix) {
  const t = Date.now().toString(36).padStart(10, '0');
  const r = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `wm_${prefix}_${t}${r}`;
}

// ---------------------------------------------------------------------------
// Reserve an act ID via the SDK
// ---------------------------------------------------------------------------

export function reserveAct(name) {
  const desc = sdkAct(name);
  return sdkReserve(desc);
}

// ---------------------------------------------------------------------------
// Act + group operations
// ---------------------------------------------------------------------------

export async function emitAct(apiKey, { outcomeId, name, opts }) {
  ensureSDK(apiKey);
  const a = sdkAct(outcomeId, name, opts || undefined);
  await sdkFlush();
  return { actId: a?.id };
}

/**
 * Create a group on a run (for release steps, etc).
 */
export async function createGroup(apiKey, { runId, label, opts }) {
  ensureSDK(apiKey);
  const g = sdkGroup(runId, label, opts);
  await sdkFlush();
  return { groupId: g.id };
}

// ---------------------------------------------------------------------------
// Query operations
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

async function getRunState(apiKey, runId) {
  const res = await fetch(`${API_URL}/v1/runs/${runId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return null;
  const { data } = await res.json();
  return data;
}

export async function findIssueRun(apiKey, { repo, issueNumber }) {
  const runs = await findRuns(apiKey, LABELS.ISSUE);
  const match = runs.find(r =>
    r.opts?.repo === repo &&
    r.opts?.issue === String(issueNumber)
  );
  if (!match) return null;

  const data = await getRunState(apiKey, match.id);
  if (!data) return null;

  const outcomes = data.outcomes || [];
  const lastOutcome = outcomes[outcomes.length - 1];
  const blockedAt = lastOutcome?.name === OUTCOMES.MAX_RETRIES ? lastOutcome.timestamp : null;

  return { runId: match.id, blockedAt, countSince: null };
}

export async function countRevisions(apiKey, { prNumber, repo, since }) {
  try {
    const runs = await findRuns(apiKey, LABELS.REVISE);
    return runs.filter(r =>
      r.opts?.pr_number === String(prNumber) &&
      r.opts?.repo === repo &&
      (!since || new Date(r.createdAt) >= new Date(since))
    ).length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Release queries
// ---------------------------------------------------------------------------

export async function findShippedIssues(apiKey) {
  const runs = await findRuns(apiKey, LABELS.ISSUE, { limit: 100 });
  const shipped = [];

  const releaseActs = await findActs(apiKey, ACTS.RELEASE);
  const actsByOutcomeId = new Map();
  for (const act of releaseActs) {
    actsByOutcomeId.set(act.refId, act);
  }

  for (const run of runs) {
    const data = await getRunState(apiKey, run.id);
    if (!data) continue;

    const outcomes = data.outcomes || [];
    if (outcomes.length === 0) continue;

    const lastOutcome = outcomes[outcomes.length - 1];
    if (lastOutcome.name === OUTCOMES.SHIPPED || lastOutcome.name === OUTCOMES.RELEASE_FAILED) {
      const shippedOutcome = [...outcomes].reverse().find(o => o.name === OUTCOMES.SHIPPED);
      if (!shippedOutcome) continue;

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

// ---------------------------------------------------------------------------
// Outcome classifications
// ---------------------------------------------------------------------------

export async function registerClassifications(apiKey) {
  for (const { name, classification } of CLASSIFICATIONS) {
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
// Pipeline operations
// ---------------------------------------------------------------------------

export async function startPipeline(apiKey, { step, label: labelOverride, repo, issueNumber, issueTitle, prNumber, refActId }) {
  ensureSDK(apiKey);
  const label = labelOverride || step.charAt(0).toUpperCase() + step.slice(1);

  const opts = { repo, step };
  if (issueNumber) opts.issue = String(issueNumber);
  if (issueTitle) opts.title = issueTitle;
  if (prNumber) opts.pr_number = String(prNumber);

  const r = refActId ? sdkRun(refActId, label, opts) : sdkRun(label, opts);
  await sdkFlush();

  return { runId: r.id };
}

export async function recordOutcome(apiKey, { runId }, { step, success, costUsd, error, hooksFailed, issueNumber, prNumber, reviewCommentCount, name: nameOverride }) {
  ensureSDK(apiKey);
  const names = {
    implement: { true: OUTCOMES.PR_CREATED, false: OUTCOMES.IMPLEMENTATION_FAILED },
    revise: { true: OUTCOMES.FIXES_APPLIED, false: OUTCOMES.REVISION_FAILED },
    merge: { true: OUTCOMES.MERGED, false: OUTCOMES.MERGE_FAILED },
    deploy: { true: OUTCOMES.DEPLOYED, false: OUTCOMES.DEPLOY_FAILED },
    release: { true: OUTCOMES.RELEASED, false: OUTCOMES.RELEASE_FAILED },
  };

  const name = nameOverride || names[step]?.[String(success)] || `${step}: ${success ? 'success' : 'failure'}`;

  const opts = { status: success ? 'success' : 'failure', step };
  if (costUsd != null) opts.cost_usd = String(costUsd);
  if (error) opts.error = error.slice(0, 500);
  if (hooksFailed) opts.hooks_failed = 'true';
  if (issueNumber) opts.issue = String(issueNumber);
  if (prNumber) opts.pr_number = String(prNumber);
  if (reviewCommentCount) opts.review_comments = String(reviewCommentCount);

  let outcomeId = null;
  if (runId) {
    const oc = sdkOutcome(runId, name, opts);
    outcomeId = oc?.id;
  }

  await sdkFlush();

  return { id: outcomeId, name };
}

export async function traceClaudeCall(apiKey, entityId, { duration, startedAt, endedAt, cost, status, turns, sessionId }) {
  ensureSDK(apiKey);
  sdkTrace(entityId, {
    provider: 'anthropic',
    model: 'claude-code',
    duration,
    startedAt,
    endedAt,
    cost,
    status,
    opts: { turns, session_id: sessionId },
  });
  await sdkFlush();
}

export async function createIssueRun(apiKey, { repo, issueNumber, issueTitle }) {
  ensureSDK(apiKey);
  const r = sdkRun(LABELS.ISSUE, { name: `Issue #${issueNumber}: ${issueTitle}`, repo, issue: String(issueNumber), version: VERSION });
  const oc = sdkOutcome(r, OUTCOMES.STARTED);
  const a = sdkAct(oc, ACTS.BUILD, { repo, issue: String(issueNumber), title: issueTitle });
  await sdkFlush();
  return { runId: r.id, actId: a.id };
}

export async function closeIssueRun(apiKey, { runId, name, opts }) {
  ensureSDK(apiKey);
  const oc = sdkOutcome(runId, name, opts);
  await sdkFlush();
  return { outcomeId: oc?.id };
}

// ---------------------------------------------------------------------------
// Issue run state queries (used by runner.js)
// ---------------------------------------------------------------------------

export const TERMINAL_OUTCOMES = new Set([
  OUTCOMES.SHIPPED,
  OUTCOMES.RELEASED,
  OUTCOMES.IMPLEMENTATION_FAILED,
  OUTCOMES.REVISION_FAILED,
  OUTCOMES.MAX_RETRIES,
  OUTCOMES.MERGE_FAILED,
  OUTCOMES.FAILED,
  OUTCOMES.ABORTED,
]);

/**
 * Find a pending act on a run or its groups (phase groups).
 * Returns { act, parentId, parentLabel } or null.
 */
function findPendingAct(data) {
  // 1. Check run's own latest outcome
  const outcomes = data.outcomes || [];
  const last = outcomes[outcomes.length - 1];
  if (last?.acts) {
    const lastAct = last.acts[last.acts.length - 1];
    if (lastAct && (!lastAct.followUpRuns || lastAct.followUpRuns.length === 0)) {
      return { act: lastAct, parentId: data.id, parentLabel: data.label };
    }
  }

  // 2. Check groups (phase groups) — newest first
  for (const group of (data.groups || []).reverse()) {
    const gOutcomes = group.outcomes || [];
    const gLast = gOutcomes[gOutcomes.length - 1];
    if (gLast?.acts) {
      const gLastAct = gLast.acts[gLast.acts.length - 1];
      if (gLastAct && (!gLastAct.followUpRuns || gLastAct.followUpRuns.length === 0)) {
        return { act: gLastAct, parentId: group.id, parentLabel: group.label };
      }
    }
  }

  return null;
}

export async function findOpenIssueRuns(apiKey) {
  const runs = await findRuns(apiKey, LABELS.ISSUE, { limit: 100 });
  const open = [];

  for (const run of runs) {
    if (run.opts?.version !== VERSION) continue;

    const data = await getRunState(apiKey, run.id);
    if (!data) continue;

    const outcomes = data.outcomes || [];
    const lastOutcome = outcomes[outcomes.length - 1];
    if (lastOutcome && TERMINAL_OUTCOMES.has(lastOutcome.name)) continue;

    // Find pending act on issue run or its phase groups.
    const pending = findPendingAct(data);
    let pendingAct = null;
    let parentEntityId = null;
    let parentEntityLabel = null;
    if (pending) {
      pendingAct = { id: pending.act.id, name: pending.act.name, opts: pending.act.opts || {} };
      parentEntityId = pending.parentId;
      parentEntityLabel = pending.parentLabel;
    }

    open.push({
      id: run.id,
      issueId: run.opts?.issue ? Number(run.opts.issue) : null,
      repo: run.opts?.repo || null,
      title: run.opts?.title || run.name || null,
      latestOutcome: lastOutcome?.name || null,
      latestOutcomeId: lastOutcome?.id || null,
      outcomes,
      pendingAct,
      parentEntityId,
      parentEntityLabel,
    });
  }

  return open;
}

export async function recordIssueOutcome(apiKey, { runId, name, opts }) {
  ensureSDK(apiKey);
  const oc = sdkOutcome(runId, name, opts);
  await sdkFlush();
  return { outcomeId: oc?.id };
}

// ---------------------------------------------------------------------------
// Release runs
// ---------------------------------------------------------------------------

export async function startReleaseRun(apiKey, { refActId, repos }) {
  ensureSDK(apiKey);
  const r = refActId
    ? sdkRun(refActId, LABELS.RELEASE, { repos: repos.join(',') })
    : sdkRun(LABELS.RELEASE, { repos: repos.join(',') });
  await sdkFlush();

  return { runId: r.id };
}
