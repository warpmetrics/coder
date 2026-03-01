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
import { OUTCOMES, ACTS, LABELS, CLASSIFICATIONS, VERSION } from '../graph/names.js';
import { TIMEOUTS } from '../defaults.js';

const API_URL = 'https://api.warpmetrics.com';
const FETCH_TIMEOUT = TIMEOUTS.API_FETCH;

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
// Batch helpers — queue SDK calls without flushing.
// Use batchFlush() to send all queued events atomically.
// ---------------------------------------------------------------------------

export function batchOutcome(apiKey, { runId, name, opts }) {
  ensureSDK(apiKey);
  const oc = sdkOutcome(runId, name, opts);
  return { outcomeId: oc?.id };
}

export function batchAct(apiKey, { outcomeId, name, opts }) {
  ensureSDK(apiKey);
  const a = sdkAct(outcomeId, name, opts || undefined);
  return { actId: a?.id };
}

export function batchGroup(apiKey, { runId, label, opts }) {
  ensureSDK(apiKey);
  const g = sdkGroup(runId, label, opts);
  return { groupId: g.id };
}

export async function batchFlush(apiKey) {
  ensureSDK(apiKey);
  await sdkFlush();
}

// ---------------------------------------------------------------------------
// Act + group operations (legacy — flush per call)
// ---------------------------------------------------------------------------

export async function emitAct(apiKey, { outcomeId, name, opts }) {
  ensureSDK(apiKey);
  const a = sdkAct(outcomeId, name, opts || undefined);
  await sdkFlush();
  return { actId: a?.id };
}

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
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.data || [];
}

async function getRunState(apiKey, runId) {
  const res = await fetch(`${API_URL}/v1/runs/${runId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) return null;
  const { data } = await res.json();
  return data;
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
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
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
    review: { true: OUTCOMES.APPROVED, false: OUTCOMES.REVIEW_FAILED },
    revise: { true: OUTCOMES.FIXES_APPLIED, false: OUTCOMES.REVISION_FAILED },
    merge: { true: OUTCOMES.MERGED, false: OUTCOMES.MERGE_FAILED },
    await_deploy: { true: OUTCOMES.DEPLOY_APPROVED, false: OUTCOMES.DEPLOY_FAILED },
    deploy: { true: OUTCOMES.DEPLOYED, false: OUTCOMES.DEPLOY_FAILED },
    await_reply: { true: OUTCOMES.CLARIFIED, false: OUTCOMES.REVIEW_FAILED },
    release: { true: OUTCOMES.RELEASED, false: OUTCOMES.RELEASE_FAILED },
  };

  const name = nameOverride || names[step]?.[String(success)] || `${step}: ${success ? 'success' : 'failure'}`;

  const opts = { status: success ? 'success' : 'failure', step };
  if (costUsd != null) opts.cost_usd = String(costUsd);
  if (error) opts.error = error.slice(0, 2000);
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

export async function traceClaudeCall(apiKey, entityId, { duration, startedAt, endedAt, cost, status, error, messages, response, turns, sessionId }) {
  ensureSDK(apiKey);
  const event = {
    provider: 'anthropic',
    model: 'claude-code',
    duration,
    startedAt,
    endedAt,
    cost,
    status,
    messages,
    response,
    opts: { turns, session_id: sessionId },
  };
  if (error) event.error = error;
  sdkTrace(entityId, event);
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
  OUTCOMES.MANUAL_RELEASE,
  OUTCOMES.RELEASED,
  OUTCOMES.CANCELLED,
]);

/**
 * Find a pending act on a run or its groups (phase groups).
 * Returns { act, parentId, parentLabel } or null.
 */
export function findPendingAct(data) {
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

function runTitle(run) {
  return run.opts?.title || run.opts?.name || run.name || null;
}

export async function findOpenIssueRuns(apiKey, { onPartial } = {}) {
  const runs = await findRuns(apiKey, LABELS.ISSUE, { limit: 100 });

  // Pre-filter using list response (no extra API calls needed).
  const candidates = runs.filter(run => {
    if (run.opts?.version !== VERSION) return false;
    const outcomes = run.outcomes || [];
    const last = outcomes[outcomes.length - 1];
    if (last && TERMINAL_OUTCOMES.has(last.name)) return false;
    return true;
  });

  // Dispatch partial data immediately so TUI can render before detail fetches.
  if (onPartial && candidates.length > 0) {
    const partial = candidates.map(run => {
      const outcomes = run.outcomes || [];
      const last = outcomes[outcomes.length - 1];
      return {
        id: run.id,
        issueId: run.opts?.issue ? Number(run.opts.issue) : null,
        repo: run.opts?.repo || null,
        title: runTitle(run),
        latestOutcome: last?.name || null,
        latestOutcomeId: last?.id || null,
        outcomes,
        pendingAct: null,
        parentEntityId: null,
        parentEntityLabel: null,
        groups: new Map(),
      };
    });
    onPartial(partial);
  }

  // Fetch full state for all candidates in parallel.
  const results = await Promise.allSettled(
    candidates.map(run => getRunState(apiKey, run.id).then(data => ({ run, data })))
  );

  const open = [];
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    const { run, data } = result.value;
    if (!data) continue;

    const outcomes = data.outcomes || [];
    const lastOutcome = outcomes[outcomes.length - 1];
    // Re-check with full data (group outcomes may differ from run-level).
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

    // Build groups map (label → groupId) and collect group outcomes.
    const groups = new Map();
    const groupOutcomes = new Map();
    for (const g of (data.groups || [])) {
      if (g.label && g.id) groups.set(g.label, g.id);
      if (g.label && g.outcomes?.length) groupOutcomes.set(g.label, g.outcomes);
    }

    open.push({
      id: run.id,
      issueId: run.opts?.issue ? Number(run.opts.issue) : null,
      repo: run.opts?.repo || null,
      title: runTitle(run),
      latestOutcome: lastOutcome?.name || null,
      latestOutcomeId: lastOutcome?.id || null,
      outcomes,
      groupOutcomes,
      pendingAct,
      parentEntityId,
      parentEntityLabel,
      groups,
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

