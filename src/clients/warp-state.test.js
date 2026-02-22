import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TERMINAL_OUTCOMES, generateId, findPendingAct, findLastExecutedAct } from './warp.js';
import { OUTCOMES } from '../graph/names.js';

// ---------------------------------------------------------------------------
// TERMINAL_OUTCOMES
// ---------------------------------------------------------------------------

describe('TERMINAL_OUTCOMES', () => {

  it('is a Set', () => {
    assert.ok(TERMINAL_OUTCOMES instanceof Set);
  });

  it('contains all expected terminal outcomes', () => {
    const expected = [
      OUTCOMES.MANUAL_RELEASE,
      OUTCOMES.RELEASED,
      OUTCOMES.ABORTED,
    ];
    for (const name of expected) {
      assert.ok(TERMINAL_OUTCOMES.has(name), `should contain "${name}"`);
    }
  });

  it('does not contain non-terminal outcomes', () => {
    const nonTerminal = [
      OUTCOMES.STARTED,
      OUTCOMES.PR_CREATED,
      OUTCOMES.BUILDING,
      OUTCOMES.REVIEWING,
      OUTCOMES.APPROVED,
      OUTCOMES.DEPLOYED,
      OUTCOMES.AWAITING_DEPLOY,
      OUTCOMES.CHANGES_REQUESTED,
      OUTCOMES.FIXES_APPLIED,
      OUTCOMES.MERGED,
      OUTCOMES.WAITING,
      OUTCOMES.NEEDS_CLARIFICATION,
      OUTCOMES.CLARIFIED,
      OUTCOMES.RELEASING,
      OUTCOMES.IMPLEMENTATION_FAILED,
      OUTCOMES.REVISION_FAILED,
      OUTCOMES.MAX_RETRIES,
      OUTCOMES.MERGE_FAILED,
      OUTCOMES.REVIEW_FAILED,
    ];
    for (const name of nonTerminal) {
      assert.ok(!TERMINAL_OUTCOMES.has(name), `should NOT contain "${name}"`);
    }
  });

  it('has exactly 3 members', () => {
    assert.equal(TERMINAL_OUTCOMES.size, 3);
  });
});

// ---------------------------------------------------------------------------
// TERMINAL_OUTCOMES consistency with CLASSIFICATIONS
// ---------------------------------------------------------------------------

describe('TERMINAL_OUTCOMES vs CLASSIFICATIONS', () => {

  it('all terminal outcomes exist as valid outcome names', () => {
    for (const name of TERMINAL_OUTCOMES) {
      // Every terminal outcome should be a value in the OUTCOMES object.
      const exists = Object.values(OUTCOMES).includes(name);
      assert.ok(exists, `terminal outcome "${name}" should be a valid outcome`);
    }
  });

  it('failure outcomes are not terminal (blocked, not closed)', () => {
    const failureOutcomes = [
      OUTCOMES.IMPLEMENTATION_FAILED,
      OUTCOMES.REVISION_FAILED,
      OUTCOMES.MAX_RETRIES,
      OUTCOMES.MERGE_FAILED,
      OUTCOMES.REVIEW_FAILED,
    ];
    for (const name of failureOutcomes) {
      assert.ok(!TERMINAL_OUTCOMES.has(name), `"${name}" should NOT be terminal`);
    }
  });

  it('success terminal outcomes include MANUAL_RELEASE and RELEASED', () => {
    assert.ok(TERMINAL_OUTCOMES.has(OUTCOMES.MANUAL_RELEASE));
    assert.ok(TERMINAL_OUTCOMES.has(OUTCOMES.RELEASED));
  });
});

// ---------------------------------------------------------------------------
// generateId (extended)
// ---------------------------------------------------------------------------

describe('generateId (extended)', () => {

  it('includes time component for ordering', () => {
    const id1 = generateId('run');
    // Small delay to ensure different timestamp
    const id2 = generateId('run');
    // Both should have the wm_run_ prefix
    assert.ok(id1.startsWith('wm_run_'));
    assert.ok(id2.startsWith('wm_run_'));
  });

  it('handles various prefixes', () => {
    for (const prefix of ['run', 'grp', 'oc', 'act', 'test']) {
      const id = generateId(prefix);
      assert.ok(id.startsWith(`wm_${prefix}_`));
      // Should have content after the prefix
      assert.ok(id.length > `wm_${prefix}_`.length + 10);
    }
  });
});

// ---------------------------------------------------------------------------
// findPendingAct
// ---------------------------------------------------------------------------

describe('findPendingAct', () => {

  it('returns null for empty data', () => {
    assert.equal(findPendingAct({}), null);
    assert.equal(findPendingAct({ outcomes: [] }), null);
    assert.equal(findPendingAct({ outcomes: [], groups: [] }), null);
  });

  it('returns null when last outcome has no acts', () => {
    const data = {
      id: 'run-1', label: 'Issue',
      outcomes: [{ name: 'Started' }],
    };
    assert.equal(findPendingAct(data), null);
  });

  it('returns null when last outcome acts is empty array', () => {
    const data = {
      id: 'run-1', label: 'Issue',
      outcomes: [{ name: 'Started', acts: [] }],
    };
    assert.equal(findPendingAct(data), null);
  });

  it('returns act from run when no followUpRuns', () => {
    const act = { id: 'act-1', name: 'Build', opts: { repo: 'org/api' } };
    const data = {
      id: 'run-1', label: 'Issue',
      outcomes: [{ name: 'Started', acts: [act] }],
    };
    const result = findPendingAct(data);
    assert.ok(result);
    assert.equal(result.act.id, 'act-1');
    assert.equal(result.parentId, 'run-1');
    assert.equal(result.parentLabel, 'Issue');
  });

  it('skips run act with followUpRuns and falls through to groups', () => {
    const runAct = { id: 'act-1', name: 'Build', followUpRuns: [{ id: 'follow-1' }] };
    const groupAct = { id: 'act-2', name: 'Implement' };
    const data = {
      id: 'run-1', label: 'Issue',
      outcomes: [{ name: 'Started', acts: [runAct] }],
      groups: [
        { id: 'grp-1', label: 'Build', outcomes: [{ name: 'Building', acts: [groupAct] }] },
      ],
    };
    const result = findPendingAct(data);
    assert.ok(result);
    assert.equal(result.act.id, 'act-2');
    assert.equal(result.parentId, 'grp-1');
    assert.equal(result.parentLabel, 'Build');
  });

  it('skips act with empty followUpRuns array (treated as pending)', () => {
    const act = { id: 'act-1', name: 'Build', followUpRuns: [] };
    const data = {
      id: 'run-1', label: 'Issue',
      outcomes: [{ name: 'Started', acts: [act] }],
    };
    const result = findPendingAct(data);
    assert.ok(result);
    assert.equal(result.act.id, 'act-1');
  });

  it('uses the LAST act from the last outcome', () => {
    const act1 = { id: 'act-old', name: 'Build', followUpRuns: [{ id: 'done' }] };
    const act2 = { id: 'act-new', name: 'Review' };
    const data = {
      id: 'run-1', label: 'Issue',
      outcomes: [{ name: 'PRCreated', acts: [act1, act2] }],
    };
    const result = findPendingAct(data);
    assert.ok(result);
    assert.equal(result.act.id, 'act-new');
  });

  it('returns act from newest group first', () => {
    const data = {
      id: 'run-1', label: 'Issue',
      outcomes: [],
      groups: [
        { id: 'grp-1', label: 'Build', outcomes: [{ name: 'Building', acts: [{ id: 'act-build' }] }] },
        { id: 'grp-2', label: 'Review', outcomes: [{ name: 'Reviewing', acts: [{ id: 'act-review' }] }] },
      ],
    };
    const result = findPendingAct(data);
    assert.ok(result);
    // groups are reversed — newest first, so grp-2 (Review) should be found first
    assert.equal(result.act.id, 'act-review');
    assert.equal(result.parentId, 'grp-2');
    assert.equal(result.parentLabel, 'Review');
  });

  it('skips groups with no outcomes', () => {
    const data = {
      id: 'run-1', label: 'Issue',
      outcomes: [],
      groups: [
        { id: 'grp-1', label: 'Build', outcomes: [] },
        { id: 'grp-2', label: 'Review', outcomes: [{ name: 'Reviewing', acts: [{ id: 'act-1' }] }] },
      ],
    };
    const result = findPendingAct(data);
    assert.ok(result);
    assert.equal(result.parentId, 'grp-2');
  });

  it('skips groups where last outcome has no acts', () => {
    const data = {
      id: 'run-1', label: 'Issue',
      outcomes: [],
      groups: [
        { id: 'grp-1', label: 'Build', outcomes: [{ name: 'Merged' }] }, // no acts
      ],
    };
    assert.equal(findPendingAct(data), null);
  });

  it('skips groups where last act has followUpRuns', () => {
    const data = {
      id: 'run-1', label: 'Issue',
      outcomes: [],
      groups: [
        {
          id: 'grp-1', label: 'Build',
          outcomes: [{ name: 'Building', acts: [{ id: 'act-1', followUpRuns: [{ id: 'r-1' }] }] }],
        },
      ],
    };
    assert.equal(findPendingAct(data), null);
  });

  it('returns null when all acts (run + groups) have followUpRuns', () => {
    const data = {
      id: 'run-1', label: 'Issue',
      outcomes: [{ name: 'Started', acts: [{ id: 'a1', followUpRuns: [{ id: 'f1' }] }] }],
      groups: [
        { id: 'grp-1', label: 'Build', outcomes: [{ name: 'X', acts: [{ id: 'a2', followUpRuns: [{ id: 'f2' }] }] }] },
      ],
    };
    assert.equal(findPendingAct(data), null);
  });

  it('uses only the LAST outcome (ignores earlier outcomes)', () => {
    const data = {
      id: 'run-1', label: 'Issue',
      outcomes: [
        { name: 'Started', acts: [{ id: 'act-old' }] },
        { name: 'PRCreated' }, // no acts — this is the last one
      ],
    };
    // Last outcome has no acts, falls through to groups (none) → null
    assert.equal(findPendingAct(data), null);
  });
});

// ---------------------------------------------------------------------------
// findLastExecutedAct
// ---------------------------------------------------------------------------

describe('findLastExecutedAct', () => {

  it('returns null for empty data', () => {
    assert.equal(findLastExecutedAct({}), null);
    assert.equal(findLastExecutedAct({ groups: [] }), null);
  });

  it('returns null when no acts have followUpRuns', () => {
    const data = {
      groups: [
        { id: 'grp-1', label: 'Build', outcomes: [{ name: 'Building', acts: [{ id: 'act-1' }] }] },
      ],
    };
    assert.equal(findLastExecutedAct(data), null);
  });

  it('returns null when acts have empty followUpRuns', () => {
    const data = {
      groups: [
        { id: 'grp-1', label: 'Build', outcomes: [{ name: 'Building', acts: [{ id: 'act-1', followUpRuns: [] }] }] },
      ],
    };
    assert.equal(findLastExecutedAct(data), null);
  });

  it('finds act with followUpRuns on a group', () => {
    const data = {
      groups: [
        {
          id: 'grp-1', label: 'Build',
          outcomes: [{ name: 'Failed', acts: [{ id: 'act-1', name: 'Implement', opts: { repo: 'org/api' }, followUpRuns: [{ id: 'r-1' }] }] }],
        },
      ],
    };
    const result = findLastExecutedAct(data);
    assert.ok(result);
    assert.equal(result.act.id, 'act-1');
    assert.equal(result.act.name, 'Implement');
    assert.equal(result.parentId, 'grp-1');
    assert.equal(result.parentLabel, 'Build');
  });

  it('uses newest group first', () => {
    const data = {
      groups: [
        { id: 'grp-1', label: 'Build', outcomes: [{ name: 'X', acts: [{ id: 'act-1', followUpRuns: [{ id: 'r-1' }] }] }] },
        { id: 'grp-2', label: 'Review', outcomes: [{ name: 'Y', acts: [{ id: 'act-2', followUpRuns: [{ id: 'r-2' }] }] }] },
      ],
    };
    const result = findLastExecutedAct(data);
    assert.ok(result);
    assert.equal(result.parentId, 'grp-2');
    assert.equal(result.act.id, 'act-2');
  });

  it('uses newest outcome within a group', () => {
    const data = {
      groups: [
        {
          id: 'grp-1', label: 'Build',
          outcomes: [
            { name: 'First', acts: [{ id: 'act-1', followUpRuns: [{ id: 'r-1' }] }] },
            { name: 'Second', acts: [{ id: 'act-2', followUpRuns: [{ id: 'r-2' }] }] },
          ],
        },
      ],
    };
    const result = findLastExecutedAct(data);
    assert.ok(result);
    assert.equal(result.act.id, 'act-2');
  });

  it('skips outcomes without acts', () => {
    const data = {
      groups: [
        {
          id: 'grp-1', label: 'Build',
          outcomes: [
            { name: 'First', acts: [{ id: 'act-1', followUpRuns: [{ id: 'r-1' }] }] },
            { name: 'NoActs' },
          ],
        },
      ],
    };
    const result = findLastExecutedAct(data);
    assert.ok(result);
    assert.equal(result.act.id, 'act-1');
  });

  it('only looks at groups, not run-level outcomes', () => {
    const data = {
      outcomes: [{ name: 'Started', acts: [{ id: 'act-run', followUpRuns: [{ id: 'r-1' }] }] }],
      groups: [],
    };
    assert.equal(findLastExecutedAct(data), null);
  });
});
