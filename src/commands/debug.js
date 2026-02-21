// Debug mode: interactive state machine testing against real WarpMetrics.
// Stub executors prompt for results — no board, no codehost, no Claude.
// Uses the act-driven architecture: each step is an act → executor → outcome → next act.

import { createInterface } from 'readline';
import { loadConfig, repoName } from '../config.js';
import * as warp from '../clients/warp.js';
import { GRAPH, ACT_EXECUTOR, RESULT_EDGES, RESULT_OUTCOMES, STATES } from '../machine.js';
import { OUTCOMES, ACTS } from '../names.js';

const RESULT_CHOICES = {
  implement: [
    { key: 's', type: 'success', label: 'success (PR created)' },
    { key: 'e', type: 'error', label: 'error (implementation failed)' },
    { key: 'a', type: 'ask_user', label: 'ask_user (needs clarification)' },
    { key: 'm', type: 'max_turns', label: 'max_turns (hit turn limit)' },
  ],
  review: [
    { key: 'a', type: 'approved', label: 'approved' },
    { key: 'c', type: 'changes_requested', label: 'changes requested' },
    { key: 'e', type: 'error', label: 'error (review failed)' },
  ],
  revise: [
    { key: 's', type: 'success', label: 'success (fixes applied)' },
    { key: 'e', type: 'error', label: 'error (revision failed)' },
    { key: 'r', type: 'max_retries', label: 'max_retries (hit revision limit)' },
  ],
  merge: [
    { key: 's', type: 'success', label: 'success (merged)' },
    { key: 'e', type: 'error', label: 'error (merge failed)' },
  ],
  await_deploy: [
    { key: 'y', type: 'approved', label: '/deploy approved' },
    { key: 'n', type: 'waiting', label: 'no /deploy yet' },
  ],
  await_reply: [
    { key: 'y', type: 'replied', label: 'user replied' },
    { key: 'n', type: 'waiting', label: 'no reply yet' },
  ],
  deploy: [
    { key: 's', type: 'success', label: 'success (deployed)' },
    { key: 'e', type: 'error', label: 'error (deploy failed)' },
  ],
  release: [
    { key: 's', type: 'success', label: 'success (released)' },
    { key: 'e', type: 'error', label: 'error (release failed)' },
  ],
};

function normalizeOutcomes(outcomes) {
  return Array.isArray(outcomes) ? outcomes : [outcomes];
}

function resolveContainer(inLabel, issueRunId, parentEntityId, parentEntityLabel) {
  if (!inLabel || inLabel === 'Issue') return issueRunId;
  if (inLabel === parentEntityLabel) return parentEntityId;
  return issueRunId; // fallback
}

export async function debug(argv) {
  const config = loadConfig();
  const repoNames = config.repos.map(r => repoName(r));
  const apiKey = config.warpmetricsApiKey;
  if (!apiKey) { console.error('Error: warpmetricsApiKey required in config'); process.exit(1); }

  const issueNumber = parseInt(argv.find(a => a.match(/^\d+$/)) || '999', 10);
  const titleFlag = argv.indexOf('--title');
  const issueTitle = titleFlag !== -1 ? argv[titleFlag + 1] : `Debug issue #${issueNumber}`;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  const log = (id, msg) => console.log(`  ${id ? `[#${id}] ` : ''}${msg}`);

  // Create a real issue run
  console.log(`\nCreating issue run: #${issueNumber} "${issueTitle}"`);
  console.log(`  repo: ${repoNames[0]}\n`);

  const { runId, actId } = await warp.createIssueRun(apiKey, {
    repo: repoNames[0], issueNumber, issueTitle,
  });
  console.log(`  issue run: ${runId}`);
  console.log(`  act: ${actId}\n`);

  // Track the current pending act — starts as BUILD from createIssueRun.
  let pendingAct = { id: actId, name: ACTS.BUILD, opts: { repo: repoNames[0], issue: String(issueNumber), title: issueTitle } };
  let latestOutcome = OUTCOMES.STARTED;
  // Track parent entity (the phase group that contains the current work act)
  let parentEntityId = null;
  let parentEntityLabel = null;

  while (true) {
    const column = STATES[latestOutcome];

    console.log(`─── column: ${column || '?'} │ outcome: ${latestOutcome} ───`);

    if (column === 'done' || column === 'blocked') {
      console.log(`\n  Terminal. Run: ${runId}`);
      console.log(`  View at: https://warpmetrics.com/app/runs/${runId}\n`);
      break;
    }

    if (!pendingAct) {
      console.log(`\n  No pending act. Run: ${runId}`);
      break;
    }

    // Phase group auto-transition
    const node = GRAPH[pendingAct.name];
    if (node && node.executor === null) {
      const result = Object.values(node.results)[0];
      const outcomes = normalizeOutcomes(result.outcomes);
      const withNext = outcomes.find(e => e.next);
      console.log(`\n  Phase: ${node.label} (auto-transition → ${withNext?.next})`);

      try {
        const containerId = parentEntityId || runId;
        const { groupId } = await warp.createGroup(apiKey, {
          runId: containerId, label: node.label,
        });
        console.log(`  group: ${groupId}`);

        let nextActId = null;
        for (const oc of outcomes) {
          const { outcomeId } = await warp.recordIssueOutcome(apiKey, { runId: groupId, name: oc.name });
          if (oc.next) {
            const { actId: newActId } = await warp.emitAct(apiKey, { outcomeId, name: oc.next, opts: pendingAct.opts });
            nextActId = newActId;
          }
        }

        // Board sync on Issue Run
        const boardOutcome = outcomes[outcomes.length - 1].name;
        await warp.recordIssueOutcome(apiKey, { runId, name: boardOutcome });

        // Update tracking: the phase group becomes the parent entity
        parentEntityId = groupId;
        parentEntityLabel = node.label;
        pendingAct = nextActId ? { id: nextActId, name: withNext.next, opts: pendingAct.opts } : null;
        latestOutcome = boardOutcome;
        if (pendingAct) console.log(`  → next act: ${pendingAct.name} (${pendingAct.id})`);
        console.log('');
      } catch (err) {
        console.log(`  warning: phase group failed: ${err.message}`);
        pendingAct = null;
      }
      continue;
    }

    const executorName = ACT_EXECUTOR[pendingAct.name];
    if (!executorName) {
      console.log(`  No executor for act: ${pendingAct.name}`);
      break;
    }

    const choices = RESULT_CHOICES[executorName];
    if (!choices) {
      console.log(`  No result choices for executor: ${executorName}`);
      break;
    }

    console.log(`\n  Act: ${pendingAct.name} → executor: ${executorName}`);
    if (parentEntityLabel) {
      console.log(`  phase: ${parentEntityLabel} (${parentEntityId})`);
    }
    if (Object.keys(pendingAct.opts || {}).length > 0) {
      console.log(`  opts: ${JSON.stringify(pendingAct.opts)}`);
    }
    for (const c of choices) console.log(`    [${c.key}] ${c.label}`);
    let choice;
    while (!choice) {
      const input = await ask(`\n  > `);
      choice = choices.find(c => c.key === input.trim().toLowerCase());
      if (!choice) console.log(`  Pick one of: ${choices.map(c => c.key).join(', ')}`);
    }

    // Resolve edges from RESULT_EDGES
    const resultKey = `${executorName}:${choice.type}`;
    const edges = RESULT_EDGES[resultKey];
    if (!edges) {
      console.log(`  No edges for ${resultKey}`);
      break;
    }

    // Create sub-run via startPipeline (like tracked() in the real runner)
    let subRunId = null, subGroupId = null;
    try {
      const p = await warp.startPipeline(apiKey, {
        step: executorName,
        label: node?.label,
        repo: pendingAct.opts?.repo || repoNames[0],
        issueNumber,
        issueTitle,
        refActId: pendingAct.id,
      });
      subRunId = p.runId;
      subGroupId = p.groupId;
      console.log(`  sub-run: ${subRunId}`);
    } catch (err) {
      console.log(`  warning: entity creation failed: ${err.message}`);
    }

    // Build nextActOpts based on what the real executors would pass
    const withNext = edges.find(e => e.next);
    let nextActOpts = {};
    if (withNext) {
      nextActOpts = { ...pendingAct.opts };
      if (choice.type === 'success' && executorName === 'implement') {
        nextActOpts = { prs: [{ repo: repoNames[0], prNumber: 1 }], issueId: issueNumber, repo: repoNames[0] };
      }
      if (choice.type === 'max_turns') {
        nextActOpts = { ...pendingAct.opts, sessionId: 'debug-session', retryCount: ((pendingAct.opts?.retryCount || 0) + 1) };
      }
    }

    const boardOutcome = edges[edges.length - 1].name;
    const success = !boardOutcome.toLowerCase().includes('failed') && boardOutcome !== OUTCOMES.MAX_RETRIES;

    // Record outcome on sub-run/group
    if (subGroupId) {
      try {
        await warp.recordOutcome(apiKey, { runId: subRunId, groupId: subGroupId }, {
          step: executorName, success, name: boardOutcome,
        });
      } catch (err) {
        console.log(`  warning: entity outcome failed: ${err.message}`);
      }
    }

    // Process all edges: record outcomes + emit act
    console.log(`  → outcome: ${boardOutcome}`);
    let recordedOnIssueRun = false;
    let newPendingAct = null;

    for (const edge of edges) {
      const containerId = resolveContainer(edge.in, runId, parentEntityId, parentEntityLabel);
      if (containerId === runId) recordedOnIssueRun = true;

      try {
        const r = await warp.recordIssueOutcome(apiKey, { runId: containerId, name: edge.name });
        if (edge.next && r.outcomeId) {
          const { actId: newActId } = await warp.emitAct(apiKey, { outcomeId: r.outcomeId, name: edge.next, opts: nextActOpts });
          newPendingAct = { id: newActId, name: edge.next, opts: nextActOpts };
          console.log(`  → next act: ${edge.next} (${newActId})`);
        }
      } catch (err) {
        console.log(`  warning: outcome/act failed: ${err.message}`);
      }
    }

    // Board sync: ensure Issue Run has the outcome
    if (!recordedOnIssueRun) {
      try {
        await warp.recordIssueOutcome(apiKey, { runId, name: boardOutcome });
      } catch {}
    }

    if (newPendingAct) {
      pendingAct = newPendingAct;
      // If cross-phase transition (act emitted on Issue Run), clear parent entity
      const actEdge = edges.find(e => e.next);
      if (!actEdge?.in || actEdge.in === 'Issue') {
        parentEntityId = null;
        parentEntityLabel = null;
      }
    } else {
      pendingAct = null;
      console.log(`  → terminal (no next act)`);
    }

    latestOutcome = boardOutcome;
    console.log('');
  }

  rl.close();
}
