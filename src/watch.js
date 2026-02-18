// Main poll loop: watches the board and processes issues concurrently.

import { loadConfig, repoName } from './config.js';
import { createBoard } from './boards/index.js';
import { implement } from './agent.js';
import { revise } from './revise.js';
import * as pr from './pr.js';
import * as git from './git.js';
import * as warp from './warp.js';
import { runHook } from './hooks.js';
import { analyzeRelease } from './release.js';

// --- Status line (spinner showing active tasks) ---
const SPINNER = ['\u28CB', '\u28D9', '\u28F9', '\u28F8', '\u28FC', '\u28F4', '\u28E6', '\u28E7', '\u28C7', '\u28CF'];
const statusTasks = new Map(); // issueId → { step, startedAt }
let spinnerIdx = 0;
let spinnerTimer = null;
const isTTY = process.stderr.isTTY;

function clearStatus() {
  if (!isTTY) return;
  process.stderr.write('\x1b[2K\r');
}

function renderStatus() {
  if (!isTTY || statusTasks.size === 0) return;
  const parts = [];
  for (const [id, { step, startedAt }] of statusTasks) {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    parts.push(`#${id} ${step}${elapsed > 2 ? ` ${elapsed}s` : ''}`);
  }
  clearStatus();
  process.stderr.write(`${SPINNER[spinnerIdx]} ${parts.join(' \u00B7 ')}`);
}

function startStatus() {
  if (!isTTY) return;
  spinnerTimer = setInterval(() => {
    spinnerIdx = (spinnerIdx + 1) % SPINNER.length;
    renderStatus();
  }, 100);
}

function stopStatus() {
  if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
  clearStatus();
}

function setStep(issueId, step) {
  statusTasks.set(issueId, { step, startedAt: Date.now() });
}

function clearStep(issueId) {
  statusTasks.delete(issueId);
  if (statusTasks.size === 0) clearStatus();
}

export async function watch() {
  const config = loadConfig();
  const board = createBoard(config);
  const pollInterval = (config.pollInterval || 30) * 1000;
  const concurrency = config.concurrency || 1;
  const repoNames = config.repos.map(repoName);

  // Track issue runs across poll cycles (issueId → { runId, blockedAt, countSince })
  const issueRuns = new Map();

  // Track in-flight issues (issueId → Promise) — one task per issue at a time
  const inFlight = new Map();

  let running = true;
  let sleepResolve = null;
  const shutdown = () => {
    if (!running) {
      stopStatus();
      console.log('\nForce exit.');
      process.exit(1);
    }
    stopStatus();
    console.log('\nShutting down... (Ctrl+C again to force)');
    running = false;
    if (sleepResolve) sleepResolve();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  startStatus();

  const log = (issueId, msg) => {
    clearStatus();
    console.log(`[${new Date().toISOString()}] [#${issueId}] ${msg}`);
  };

  console.log(`[${new Date().toISOString()}] warp-coder watching...`);
  console.log(`  board: ${config.board.provider}${config.board.project ? ` (project ${config.board.project})` : ''}`);
  console.log(`  repos: ${repoNames.join(', ')}`);
  console.log(`  concurrency: ${concurrency}`);
  console.log(`  poll interval: ${config.pollInterval || 30}s`);

  // Recover items stuck in "In Progress" from a previous crash
  try {
    await board.refresh();
    const stuckItems = await board.listInProgress();
    for (const item of stuckItems) {
      const issueId = item._issueId;
      if (!issueId) continue;

      const branchPattern = typeof issueId === 'number' ? `agent/issue-${issueId}` : `agent/${issueId}`;
      const prs = pr.findAllPRs(issueId, repoNames, { branchPattern });
      if (prs.length > 0) {
        await board.moveToReview(item);
        console.log(`[${new Date().toISOString()}] [#${issueId}] recovered: moved to In Review (PRs found)`);
      } else {
        await board.moveToTodo(item);
        console.log(`[${new Date().toISOString()}] [#${issueId}] recovered: moved to Todo (no PR found)`);
      }
    }
  } catch (err) {
    console.log(`[${new Date().toISOString()}] Recovery check failed: ${err.message}`);
  }

  while (running) {
    try {
      pr.clearCache();
      await board.refresh();

      const work = [];

      const todoItems = await board.listTodo();
      for (const item of todoItems) {
        const issueId = item._issueId;
        if (issueId && !inFlight.has(issueId)) {
          work.push({ type: 'implement', item, issueId });
        }
      }

      // Get review items + classify via pr.js
      const reviewItems = await board.listInReview();
      const { needsRevision, approved } = pr.classifyReviewItems(reviewItems, repoNames);

      for (const item of needsRevision) {
        const issueId = item._issueId;
        if (issueId && !inFlight.has(issueId)) {
          work.push({ type: 'revise', item, issueId });
        }
      }

      for (const item of approved) {
        const issueId = item._issueId;
        if (issueId && !inFlight.has(issueId)) {
          work.push({ type: 'merge', item, issueId });
        }
      }

      // Check waiting items for user replies
      const waitingItems = await board.listWaiting();
      for (const item of waitingItems) {
        const issueId = item._issueId;
        if (issueId && !inFlight.has(issueId)) {
          work.push({ type: 'waiting', item, issueId });
        }
      }

      // Launch into available slots
      const available = concurrency - inFlight.size;
      for (const task of work.slice(0, available)) {
        const promise = processTask(task, { board, config, log, repoNames, issueRuns })
          .catch(err => log(task.issueId, `task error: ${err.message}`))
          .finally(() => inFlight.delete(task.issueId));
        inFlight.set(task.issueId, promise);
      }

      if (work.length === 0 && inFlight.size === 0) {
        console.log(`[${new Date().toISOString()}] Nothing to do`);
      } else if (work.length > available) {
        const skipped = work.length - available;
        console.log(`[${new Date().toISOString()}] ${inFlight.size}/${concurrency} slots in use, ${skipped} item(s) waiting`);
      }
    } catch (err) {
      console.log(`[${new Date().toISOString()}] Poll error: ${err.message}`);
    }

    // Sleep (interruptible)
    if (running) {
      await new Promise(resolve => {
        sleepResolve = resolve;
        setTimeout(() => { sleepResolve = null; resolve(); }, pollInterval);
      });
    }
  }

  // Wait for in-flight tasks to finish before exiting
  if (inFlight.size > 0) {
    clearStatus();
    console.log(`[${new Date().toISOString()}] Waiting for ${inFlight.size} in-flight task(s)...`);
    await Promise.allSettled(inFlight.values());
  }

  stopStatus();
  console.log(`[${new Date().toISOString()}] Stopped.`);
}

async function processTask({ type, item, issueId }, { board, config, log: logFn, repoNames, issueRuns }) {
  const log = msg => logFn(issueId, msg);
  const primaryRepo = repoNames[0];
  const onStep = (step) => setStep(issueId, step);
  const onBeforeLog = clearStatus;

  const stepMap = { implement: 'implementing', revise: 'revising', merge: 'merging', waiting: 'checking' };
  setStep(issueId, stepMap[type] || type);

  try {
    if (type === 'implement') {
      await processImplement(item, { issueId, board, config, log, repoNames, primaryRepo, issueRuns, onStep, onBeforeLog });
    } else if (type === 'revise') {
      await processRevise(item, { issueId, board, config, log, repoNames, primaryRepo, issueRuns, onStep, onBeforeLog });
    } else if (type === 'merge') {
      await processMerge(item, { issueId, board, config, log, repoNames, primaryRepo, issueRuns });
    } else if (type === 'waiting') {
      await processWaiting(item, { issueId, board, config, log, primaryRepo, issueRuns });
    }
  } finally {
    clearStep(issueId);
  }
}

async function processImplement(item, { issueId, board, config, log, primaryRepo, issueRuns, onStep, onBeforeLog }) {
  const issueTitle = item.content?.title;
  log(`Found todo: ${issueTitle}`);

  let implementActId = null;
  const existingCtx = issueRuns.get(issueId);

  if (existingCtx?.implementActId) {
    // Resuming after clarification — use the stored act ID
    implementActId = existingCtx.implementActId;
    existingCtx.implementActId = null;
  } else if (config.warpmetricsApiKey && !existingCtx) {
    try {
      const issue = await warp.createIssueRun(config.warpmetricsApiKey, {
        repo: primaryRepo, issueNumber: issueId, issueTitle,
      });
      issueRuns.set(issueId, { runId: issue.runId, blockedAt: null, countSince: null });
      implementActId = issue.actId;
      log(`issue run: ${issue.runId}`);

      // Post run link on the issue
      try {
        git.botComment(issueId, { repo: primaryRepo, runId: issue.runId, body: `Working on this.` });
      } catch {}
    } catch (err) {
      log(`warning: issue run creation failed: ${err.message}`);
    }
  }

  // Check for a stored session to resume (from a previous max-turns failure)
  const resumeSession = existingCtx?.resumeSessionId || null;
  if (resumeSession) {
    existingCtx.resumeSessionId = null;
    log(`resuming claude session ${resumeSession}`);
  }

  const result = await implement(item, { board, config, log, refActId: implementActId, resumeSession, onStep, onBeforeLog });

  // Store session ID for resume if Claude hit max turns
  if (result.hitMaxTurns && result.sessionId) {
    const issueCtx = issueRuns.get(issueId);
    if (issueCtx) {
      issueCtx.resumeSessionId = result.sessionId;
    } else {
      issueRuns.set(issueId, { runId: null, blockedAt: null, countSince: null, resumeSessionId: result.sessionId });
    }
    log(`stored session ${result.sessionId} for resume`);
  }

  if (result.askUser) {
    // Record WarpMetrics clarification chain
    let clarifyRunId = null;
    let clarifyGroupId = null;
    const issueCtx = issueRuns.get(issueId);

    if (config.warpmetricsApiKey && issueCtx) {
      try {
        const clarify = await warp.recordClarification(config.warpmetricsApiKey, {
          issueRunId: issueCtx.runId,
          question: result.askUser,
        });
        clarifyRunId = clarify.clarifyRunId;
        clarifyGroupId = clarify.clarifyGroupId;
      } catch (err) {
        log(`warning: clarification recording failed: ${err.message}`);
      }
    }

    // Post question comment on issue with embedded IDs for recovery
    const attrs = [
      issueCtx?.runId ? `issueRunId=${issueCtx.runId}` : '',
      clarifyRunId ? `clarifyRunId=${clarifyRunId}` : '',
      clarifyGroupId ? `clarifyGroupId=${clarifyGroupId}` : '',
    ].filter(Boolean).join(' ');
    const marker = `<!-- warp-coder:question${attrs ? ` ${attrs}` : ''} -->`;

    try {
      git.botComment(issueId, { repo: primaryRepo, runId: issueCtx?.runId, body: `${marker}\n\nNeeds clarification:\n\n${result.askUser}` });
      log(`posted clarification question on issue #${issueId}`);
    } catch (err) {
      log(`warning: failed to post question: ${err.message}`);
    }

    // Move to Waiting
    try {
      await board.moveToWaiting(item);
      log(`moved to Waiting`);
    } catch (err) {
      log(`warning: could not move to Waiting: ${err.message}`);
    }
  } else if (!result.success) {
    // Implementation failed — record on the issue run
    const issueCtx = issueRuns.get(issueId);
    if (config.warpmetricsApiKey && issueCtx) {
      try {
        await warp.closeIssueRun(config.warpmetricsApiKey, {
          runId: issueCtx.runId, name: 'Implementation Failed',
        });
      } catch {}
    }
  }
}

async function processRevise(item, { issueId, board, config, log, primaryRepo, issueRuns, onStep, onBeforeLog }) {
  let issueCtx = issueRuns.get(issueId) || null;
  log(`Found review feedback: ${item._prs?.length || 0} PR(s)`);

  if (!issueCtx && config.warpmetricsApiKey) {
    try {
      const recovered = await warp.findIssueRun(config.warpmetricsApiKey, { repo: primaryRepo, issueNumber: issueId });
      if (recovered) {
        issueRuns.set(issueId, recovered);
        issueCtx = recovered;
        log(`recovered issue run: ${recovered.runId}`);
      }
    } catch (err) {
      log(`warning: could not recover issue run: ${err.message}`);
    }
  }

  if (issueCtx?.blockedAt) {
    issueCtx.countSince = issueCtx.blockedAt;
    issueCtx.blockedAt = null;
    log(`resumed from blocked (counter reset, since: ${issueCtx.countSince})`);
    if (config.warpmetricsApiKey) {
      try {
        await warp.closeIssueRun(config.warpmetricsApiKey, {
          runId: issueCtx.runId, name: 'Resumed',
        });
      } catch {}
    }
  }

  const result = await revise(item, { board, config, log, refActId: item._reviewActId, since: issueCtx?.countSince, onStep, onBeforeLog });

  if (!result.success) {
    const isMaxRetries = result.reason === 'max_retries';
    const message = isMaxRetries
      ? `Hit revision limit (${result.count} attempts) — needs human help.`
      : `Revision failed — moved to Blocked.`;
    try {
      git.botComment(issueId, { repo: primaryRepo, runId: issueCtx?.runId, body: message });
    } catch {}

    if (issueCtx && config.warpmetricsApiKey) {
      const name = isMaxRetries ? 'Max Retries' : 'Revision Failed';
      issueCtx.blockedAt = new Date().toISOString();
      issueCtx.countSince = null;
      try {
        await warp.closeIssueRun(config.warpmetricsApiKey, {
          runId: issueCtx.runId,
          name,
          opts: { pr_number: String(item._prNumber || ''), revisions: String(result.count || '') },
        });
        log(`issue run: ${name}`);
      } catch (err) {
        log(`warning: issue run outcome failed: ${err.message}`);
      }
    }
  }
}

async function processWaiting(item, { issueId, board, config, log, primaryRepo, issueRuns }) {
  // Check if the user has replied to the agent's question
  let comments;
  try {
    comments = git.getIssueComments(issueId, { repo: primaryRepo });
  } catch (err) {
    log(`warning: could not fetch issue comments: ${err.message}`);
    return;
  }

  // Find the last bot question
  const lastQuestionIdx = comments.findLastIndex(c =>
    c.body?.includes('<!-- warp-coder:question')
  );
  if (lastQuestionIdx === -1) {
    log(`no question comment found — moving to Todo`);
    try { await board.moveToTodo(item); } catch {}
    return;
  }

  // Still waiting — question is the last comment
  if (lastQuestionIdx === comments.length - 1) return;

  // User has replied
  log(`user replied to clarification question`);

  // Parse WarpMetrics IDs from the question comment marker
  const questionBody = comments[lastQuestionIdx].body || '';
  const markerMatch = questionBody.match(/<!-- warp-coder:question\s*(.*?)\s*-->/);
  const attrs = {};
  if (markerMatch?.[1]) {
    for (const pair of markerMatch[1].split(/\s+/)) {
      const [k, v] = pair.split('=');
      if (k && v) attrs[k] = v;
    }
  }

  // Record "Clarified" outcome and "Implement" act on the Clarify run
  if (config.warpmetricsApiKey && attrs.clarifyRunId && attrs.clarifyGroupId) {
    try {
      const { actId } = await warp.recordClarified(config.warpmetricsApiKey, {
        clarifyRunId: attrs.clarifyRunId,
        clarifyGroupId: attrs.clarifyGroupId,
      });
      // Store the act ID so the next implementation chains from it
      const issueCtx = issueRuns.get(issueId);
      if (issueCtx) {
        issueCtx.implementActId = actId;
      } else if (attrs.issueRunId) {
        issueRuns.set(issueId, { runId: attrs.issueRunId, blockedAt: null, countSince: null, implementActId: actId });
      }
      log(`recorded Clarified → Implement act`);
    } catch (err) {
      log(`warning: clarified recording failed: ${err.message}`);
    }
  }

  // Move back to Todo for re-implementation
  try {
    await board.moveToTodo(item);
    log(`moved to Todo`);
  } catch (err) {
    log(`warning: could not move to Todo: ${err.message}`);
  }
}

async function processMerge(item, { issueId, board, config, log, repoNames, primaryRepo, issueRuns }) {
  const prs = item._prs || [];
  const refActId = item._reviewActId;
  const allPrNumbers = prs.map(p => `${p.repo}#${p.prNumber}`).join(', ');
  log(`Merging ${prs.length} approved PR(s): ${allPrNumbers}`);

  let mergeRunId = null;
  let mergeGroupId = null;
  if (config.warpmetricsApiKey) {
    try {
      const prNumbers = prs.map(p => String(p.prNumber)).join(',');
      const pipeline = await warp.startPipeline(config.warpmetricsApiKey, {
        step: 'merge', repo: primaryRepo, prNumber: prNumbers, refActId,
      });
      mergeRunId = pipeline.runId;
      mergeGroupId = pipeline.groupId;
    } catch (err) {
      log(`warning: merge pipeline failed: ${err.message}`);
    }
  }

  // Merge each PR individually, tracking which succeeded for partial-failure recovery
  const merged = [];
  let mergeError = null;

  for (const { repo, prNumber } of prs) {
    try {
      // Check if PR is still open (may have been merged in a previous partial attempt)
      try {
        const state = git.getPRState(prNumber, { repo });
        if (state !== 'OPEN') {
          log(`PR #${prNumber} in ${repo} already ${state.toLowerCase()} — skipping`);
          merged.push({ repo, prNumber });
          continue;
        }
      } catch {
        // getPRState failed — try merging anyway
      }

      runHook('onBeforeMerge', config, { prNumber, repo });
      git.mergePR(prNumber, { repo });
      merged.push({ repo, prNumber });
      log(`merged PR #${prNumber} in ${repo}`);
      try { runHook('onMerged', config, { prNumber, repo }); } catch (err) {
        log(`warning: onMerged hook failed: ${err.message}`);
      }
    } catch (err) {
      mergeError = err;
      log(`merge failed for PR #${prNumber} in ${repo}: ${err.message}`);
      break;
    }
  }

  const allMerged = merged.length === prs.length;

  if (allMerged) {
    // Collect PR details for summary + changelog
    let prDetails = [];
    try {
      for (const { repo, prNumber } of prs) {
        const files = git.getPRFiles(prNumber, { repo });
        const commits = git.getPRCommits(prNumber, { repo });
        prDetails.push({ repo, prNumber, files, commits });
      }
    } catch (err) {
      log(`warning: failed to gather PR details: ${err.message}`);
    }

    // Post summary comment on the issue
    try {
      const sections = [];
      for (const { repo, prNumber, files, commits } of prDetails) {
        const repoShort = repo.split('/').pop();

        const totalAdditions = files.reduce((s, f) => s + (f.additions || 0), 0);
        const totalDeletions = files.reduce((s, f) => s + (f.deletions || 0), 0);
        const commitLines = commits.map(c => {
          const headline = c.messageHeadline || c.message?.split('\n')[0] || '';
          return `- ${headline}`;
        }).join('\n');
        const fileLines = files.map(f => `- \`${f.path}\``).join('\n');

        sections.push([
          `### \`${repoShort}\` — ${repo}#${prNumber}`,
          '**Commits:**',
          commitLines,
          '',
          `${files.length} file${files.length !== 1 ? 's' : ''} changed (+${totalAdditions} −${totalDeletions})`,
          '<details><summary>Files</summary>',
          '',
          fileLines,
          '',
          '</details>',
        ].join('\n'));
      }

      const issueCtx = issueRuns.get(issueId);
      git.botComment(issueId, { repo: primaryRepo, runId: issueCtx?.runId, body: `Shipped\n\n${sections.join('\n\n')}` });
      log(`posted summary on issue #${issueId}`);
    } catch (err) {
      log(`warning: failed to post issue summary: ${err.message}`);
    }

    await board.moveToDone(item);
    log(`moved to Done`);

    if (config.warpmetricsApiKey && mergeGroupId) {
      try {
        await warp.recordOutcome(config.warpmetricsApiKey, { runId: mergeRunId, groupId: mergeGroupId }, {
          step: 'merge', success: true, prNumber: prs[0]?.prNumber,
        });
      } catch {}
    }

    let issueCtx = issueRuns.get(issueId) || null;
    if (!issueCtx && config.warpmetricsApiKey) {
      try {
        const recovered = await warp.findIssueRun(config.warpmetricsApiKey, { repo: primaryRepo, issueNumber: issueId });
        if (recovered) {
          issueRuns.set(issueId, recovered);
          issueCtx = recovered;
          log(`recovered issue run: ${recovered.runId}`);
        }
      } catch (err) {
        log(`warning: could not recover issue run: ${err.message}`);
      }
    }
    if (config.warpmetricsApiKey && issueCtx) {
      try {
        let releaseOpts = null;
        try {
          releaseOpts = analyzeRelease(prs, repoNames);
        } catch (err) {
          log(`warning: release analysis failed: ${err.message}`);
        }

        const { outcomeId } = await warp.closeIssueRun(config.warpmetricsApiKey, {
          runId: issueCtx.runId, name: 'Shipped', opts: releaseOpts,
        });

        // Emit Release act — signals this issue needs releasing
        try {
          await warp.emitAct(config.warpmetricsApiKey, {
            outcomeId,
            actId: warp.generateId('act'),
            name: 'Release',
          });
        } catch (err) {
          log(`warning: release act emission failed: ${err.message}`);
        }

        issueRuns.delete(issueId);
      } catch {}
    }
  } else {
    // Partial merge failure
    if (merged.length > 0) {
      log(`partial merge: ${merged.length}/${prs.length} PRs merged before failure`);
    }
    if (config.warpmetricsApiKey && mergeGroupId) {
      try {
        await warp.recordOutcome(config.warpmetricsApiKey, { runId: mergeRunId, groupId: mergeGroupId }, {
          step: 'merge', success: false, error: mergeError?.message, prNumber: prs[0]?.prNumber,
        });
      } catch {}
    }
    // Move to Blocked so human can inspect the partial state
    try {
      await board.moveToBlocked(item);
      log(`moved to Blocked for manual review`);
    } catch {}
  }
}


