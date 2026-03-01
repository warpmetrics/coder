// Comment-based interrupt system for stuck runs.
// Scans GitHub issue comments for human instructions and uses an LLM
// to classify the intent into an available trigger action.

import { z } from 'zod';
import { TIMEOUTS } from './defaults.js';

// ---------------------------------------------------------------------------
// Schema — built dynamically from available triggers.
// ---------------------------------------------------------------------------

export function buildInterruptSchema(triggerNames) {
  return z.toJSONSchema(z.object({
    action: z.enum(['none', ...triggerNames]).describe(
      'The trigger to execute, or "none" if the comment is not actionable.'
    ),
    phase: z.string().optional().describe(
      'Target checkpoint phase (e.g. "Build", "Review"). Only used with reset-type triggers. Omit to use default.'
    ),
    reason: z.string().describe('Brief explanation of why this action was chosen.'),
  }));
}

// Standalone schema for test fallback parsing (accepts any string action).
export const InterruptSchema = z.object({
  action: z.string(),
  phase: z.string().optional(),
  reason: z.string(),
});

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildInterruptPrompt(commentBody, run, availableTriggers) {
  const triggerList = availableTriggers.map(t => `- ${t.name}: ${t.label}`).join('\n');
  const validValues = ['none', ...availableTriggers.map(t => t.name)];

  return `A GitHub issue is stuck (no work in progress). A user left a comment. Pick the best trigger to execute, or "none" if the comment is not actionable.

When in doubt, choose "none" — false positives are worse than missed commands.

## Run State
- Issue: #${run.issueId} "${run.title || ''}"
- Last outcome: ${run.latestOutcome || 'unknown'}

## Available Triggers
${triggerList}

## User Comment
${commentBody}`;
}

// ---------------------------------------------------------------------------
// scanForNewComment — find unprocessed human comment after last bot comment.
// ---------------------------------------------------------------------------

export async function scanForNewComment(issues, issueId, repo, processedComments) {
  let comments;
  try {
    comments = await issues.getIssueComments(issueId, { repo });
  } catch {
    return null;
  }
  if (!comments || !comments.length) return null;

  // Find last bot comment (contains 'warp-coder').
  let lastBotIdx = -1;
  for (let i = comments.length - 1; i >= 0; i--) {
    if ((comments[i].body || '').includes('warp-coder')) {
      lastBotIdx = i;
      break;
    }
  }

  // Look for first unprocessed human comment after the last bot comment.
  const processed = processedComments?.get(issueId);
  const startIdx = lastBotIdx + 1;
  for (let i = startIdx; i < comments.length; i++) {
    const c = comments[i];
    if ((c.body || '').includes('warp-coder')) continue; // skip bot comments
    if (processed?.has(c.id)) continue; // skip already processed
    return c;
  }

  return null;
}

// ---------------------------------------------------------------------------
// evaluateInterrupt — LLM classification of the comment intent.
// Returns { action: triggerName | 'none', phase?, reason }.
// ---------------------------------------------------------------------------

export async function evaluateInterrupt(claudeCode, comment, run, availableTriggers, { log, onBeforeLog } = {}) {
  const start = Date.now();
  log?.(`  evaluateInterrupt: classifying comment...`);

  const triggerNames = availableTriggers.map(t => t.name);

  try {
    const prompt = buildInterruptPrompt(comment.body, run, availableTriggers);
    const jsonSchema = buildInterruptSchema(triggerNames);
    const res = await claudeCode.run({
      prompt,
      jsonSchema,
      maxTurns: 2,
      noSessionPersistence: true,
      timeout: TIMEOUTS.CLAUDE_QUICK,
      verbose: true,
      logPrefix: '[interrupt]',
      onBeforeLog,
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    let parsed = res.structuredOutput;
    if (!parsed) {
      // Fallback: parse from text.
      const safeParsed = InterruptSchema.safeParse(
        typeof res.result === 'string'
          ? (() => { try { return JSON.parse(res.result); } catch { return null; } })()
          : res.result
      );
      if (safeParsed?.success) parsed = safeParsed.data;
    }

    if (!parsed || !parsed.action) {
      log?.(`  evaluateInterrupt: no structured output, defaulting to none (${elapsed}s)`);
      return { action: 'none', reason: 'parse failure' };
    }

    // Validate the action is a known trigger.
    if (parsed.action !== 'none' && !triggerNames.includes(parsed.action)) {
      log?.(`  evaluateInterrupt: action '${parsed.action}' not available, defaulting to none (${elapsed}s)`);
      return { action: 'none', reason: `action '${parsed.action}' not available` };
    }

    log?.(`  evaluateInterrupt: ${parsed.action}${parsed.phase ? ` → ${parsed.phase}` : ''} (${elapsed}s) — ${parsed.reason}`);
    return { action: parsed.action, phase: parsed.phase, reason: parsed.reason };
  } catch (err) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log?.(`  evaluateInterrupt failed (${elapsed}s, defaulting to none): ${err.message}`);
    return { action: 'none', reason: `error: ${err.message}` };
  }
}
