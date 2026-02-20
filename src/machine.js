// Pure state machine for issue lifecycle.
// Zero I/O — every mapping is testable data.
//
// GRAPH is the single source of truth. All other exports are derived from it.

import { OUTCOMES, ACTS } from './names.js';

// ---------------------------------------------------------------------------
// Graph: the complete workflow definition.
//
// Each node defines:
//   label    — entity label
//   executor — function that does the work (null = phase group, auto-transitions)
//   group    — parent group label (executor work is nested under this group)
//   results  — for each result type, an outcomes object or array:
//              { name, in?, next? }  or  [{ name, in?, next? }, ...]
//
//     name — outcome name to record
//     in   — where to record ('Issue' | '<phase label>', omitted = Issue Run)
//     next — act to emit from this outcome (omitted = no act)
// ---------------------------------------------------------------------------

export const GRAPH = {
  // ── Phase: Build ──────────────────────────────────────────────
  [ACTS.BUILD]: {
    label: 'Build',
    executor: null,
    results: {
      created: { outcomes: { name: OUTCOMES.BUILDING, next: ACTS.IMPLEMENT } },
    },
  },
  [ACTS.IMPLEMENT]: {
    label: 'Implement',
    group: 'Build',
    executor: 'implement',
    results: {
      success: {
        outcomes: [
          { name: OUTCOMES.PR_CREATED, in: 'Build' },
          { name: OUTCOMES.PR_CREATED, in: 'Issue', next: ACTS.REVIEW },
        ],
      },
      error:     { outcomes: { name: OUTCOMES.IMPLEMENTATION_FAILED } },
      ask_user:  { outcomes: { name: OUTCOMES.NEEDS_CLARIFICATION, in: 'Build', next: ACTS.AWAIT_REPLY } },
      max_turns: { outcomes: { name: OUTCOMES.PAUSED, in: 'Build', next: ACTS.IMPLEMENT } },
    },
  },
  [ACTS.AWAIT_REPLY]: {
    label: 'Await Reply',
    group: 'Build',
    executor: 'await_reply',
    results: {
      replied: { outcomes: { name: OUTCOMES.CLARIFIED, in: 'Build', next: ACTS.IMPLEMENT } },
      waiting: { outcomes: { name: OUTCOMES.WAITING,   in: 'Build', next: ACTS.AWAIT_REPLY } },
    },
  },

  // ── Phase: Review ─────────────────────────────────────────────
  [ACTS.REVIEW]: {
    label: 'Review',
    executor: null,
    results: {
      created: { outcomes: { name: OUTCOMES.REVIEWING, next: ACTS.EVALUATE } },
    },
  },
  [ACTS.EVALUATE]: {
    label: 'Evaluate',
    group: 'Review',
    executor: 'review',
    results: {
      approved:          { outcomes: { name: OUTCOMES.APPROVED,           in: 'Review', next: ACTS.MERGE } },
      changes_requested: { outcomes: { name: OUTCOMES.CHANGES_REQUESTED, in: 'Review', next: ACTS.REVISE } },
      error:             { outcomes: { name: OUTCOMES.FAILED,             in: 'Review', next: ACTS.EVALUATE } },
    },
  },
  [ACTS.REVISE]: {
    label: 'Revise',
    group: 'Review',
    executor: 'revise',
    results: {
      success:     { outcomes: { name: OUTCOMES.FIXES_APPLIED, in: 'Review', next: ACTS.EVALUATE } },
      error:       { outcomes: { name: OUTCOMES.REVISION_FAILED } },
      max_retries: { outcomes: { name: OUTCOMES.MAX_RETRIES } },
    },
  },
  [ACTS.MERGE]: {
    label: 'Merge',
    group: 'Review',
    executor: 'merge',
    results: {
      success: {
        outcomes: [
          { name: OUTCOMES.MERGED, in: 'Review' },
          { name: OUTCOMES.MERGED, in: 'Issue', next: ACTS.DEPLOY },
        ],
      },
      error: { outcomes: { name: OUTCOMES.MERGE_FAILED } },
    },
  },

  // ── Phase: Deploy ─────────────────────────────────────────────
  [ACTS.DEPLOY]: {
    label: 'Deploy',
    executor: null,
    results: {
      created: { outcomes: { name: OUTCOMES.AWAITING_DEPLOY, next: ACTS.AWAIT_DEPLOY } },
    },
  },
  [ACTS.AWAIT_DEPLOY]: {
    label: 'Deploy Check',
    group: 'Deploy',
    executor: 'await_deploy',
    results: {
      approved: { outcomes: { name: OUTCOMES.DEPLOY_APPROVED, in: 'Deploy', next: ACTS.RUN_DEPLOY } },
      waiting:  { outcomes: { name: OUTCOMES.AWAITING_DEPLOY, in: 'Deploy', next: ACTS.AWAIT_DEPLOY } },
    },
  },
  [ACTS.RUN_DEPLOY]: {
    label: 'Deploy Execution',
    group: 'Deploy',
    executor: 'deploy',
    results: {
      success: {
        outcomes: [
          { name: OUTCOMES.DEPLOYED, in: 'Deploy' },
          { name: OUTCOMES.DEPLOYED, in: 'Issue', next: ACTS.RELEASE },
        ],
      },
      error: { outcomes: { name: OUTCOMES.DEPLOY_FAILED, in: 'Deploy', next: ACTS.AWAIT_DEPLOY } },
    },
  },

  // ── Phase: Release ────────────────────────────────────────────
  [ACTS.RELEASE]: {
    label: 'Release',
    executor: null,
    results: {
      created: { outcomes: { name: OUTCOMES.RELEASING, next: ACTS.PUBLISH } },
    },
  },
  [ACTS.PUBLISH]: {
    label: 'Release Notes',
    group: 'Release',
    executor: 'release',
    results: {
      success: {
        outcomes: [
          { name: OUTCOMES.RELEASED, in: 'Release' },
          { name: OUTCOMES.RELEASED },
        ],
      },
      error: { outcomes: { name: OUTCOMES.RELEASE_FAILED, in: 'Release', next: ACTS.PUBLISH } },
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeOutcomes(outcomes) {
  return Array.isArray(outcomes) ? outcomes : [outcomes];
}

// ---------------------------------------------------------------------------
// Derived maps — all computed from GRAPH.
// Phase groups (executor === null) are excluded from executor-keyed maps.
// ---------------------------------------------------------------------------

// Act name → executor function name (only work acts).
export const ACT_EXECUTOR = Object.fromEntries(
  Object.entries(GRAPH)
    .filter(([, node]) => node.executor !== null)
    .map(([act, node]) => [act, node.executor])
);

// Act name → parent group label (from node.group, only work acts).
export const ACT_GROUP = Object.fromEntries(
  Object.entries(GRAPH)
    .filter(([, node]) => node.executor !== null && node.group)
    .map(([act, node]) => [act, node.group])
);

// executor:resultType → normalized outcomes array [{ name, in?, next? }].
export const RESULT_EDGES = {};

// executor:resultType → last outcome name (for board column lookup).
export const RESULT_OUTCOMES = {};

// executor:resultType → next act name (from whichever outcome has it, or null).
export const NEXT_ACT = {};

for (const node of Object.values(GRAPH)) {
  if (node.executor === null) continue;
  for (const [resultType, result] of Object.entries(node.results)) {
    const key = `${node.executor}:${resultType}`;
    const edges = normalizeOutcomes(result.outcomes);
    RESULT_EDGES[key] = edges;
    RESULT_OUTCOMES[key] = edges[edges.length - 1].name;
    NEXT_ACT[key] = edges.find(e => e.next)?.next || null;
  }
}

// ---------------------------------------------------------------------------
// Board sync — maps outcome names directly to board columns.
// Separate from the graph: the graph defines workflow, this defines UI.
// ---------------------------------------------------------------------------

export const BOARD_COLUMNS = {
  // External outcomes (not produced by graph, but need column mapping)
  [OUTCOMES.STARTED]: 'todo',
  [OUTCOMES.RESUMED]: 'inProgress',
  [OUTCOMES.SHIPPED]: 'done',
  [OUTCOMES.ABORTED]: 'blocked',

  // Phase group auto-transition outcomes
  [OUTCOMES.BUILDING]: 'inProgress',
  [OUTCOMES.REVIEWING]: 'inReview',
  [OUTCOMES.RELEASING]: 'deploy',

  // Graph-produced outcomes
  [OUTCOMES.PR_CREATED]: 'inReview',
  [OUTCOMES.FIXES_APPLIED]: 'inReview',
  [OUTCOMES.CHANGES_REQUESTED]: 'inProgress',
  [OUTCOMES.APPROVED]: 'inReview',
  [OUTCOMES.NEEDS_CLARIFICATION]: 'waiting',
  [OUTCOMES.CLARIFIED]: 'inProgress',
  [OUTCOMES.PAUSED]: 'blocked',
  [OUTCOMES.WAITING]: 'waiting',
  [OUTCOMES.MERGED]: 'readyForDeploy',
  [OUTCOMES.AWAITING_DEPLOY]: 'readyForDeploy',
  [OUTCOMES.DEPLOY_APPROVED]: 'deploy',
  [OUTCOMES.DEPLOYED]: 'deploy',
  [OUTCOMES.DEPLOY_FAILED]: 'blocked',
  [OUTCOMES.RELEASED]: 'done',
  [OUTCOMES.RELEASE_FAILED]: 'blocked',
  [OUTCOMES.IMPLEMENTATION_FAILED]: 'blocked',
  [OUTCOMES.REVISION_FAILED]: 'blocked',
  [OUTCOMES.MAX_RETRIES]: 'blocked',
  [OUTCOMES.MERGE_FAILED]: 'blocked',
  [OUTCOMES.FAILED]: 'blocked',
};
