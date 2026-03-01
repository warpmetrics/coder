// Reset command: re-emit a checkpoint act on a stuck Issue run.
// Usage: warp-coder reset <issue#> [phase]

import { loadConfig } from '../config.js';
import * as warp from '../clients/warp.js';
import { GRAPH, STATES, TRIGGERS } from '../graph/machine.js';
import { executeTrigger } from '../graph/ops.js';

export async function reset(args) {
  const issueNumber = parseInt(args[0], 10);
  if (!issueNumber) {
    console.error('Usage: warp-coder reset <issue#> [phase]');
    process.exit(1);
  }
  const phaseOverride = args[1] || null;

  const config = loadConfig();
  const apiKey = config.warpmetricsApiKey;
  if (!apiKey) {
    console.error('No WarpMetrics API key configured.');
    process.exit(1);
  }

  const openRuns = await warp.findOpenIssueRuns(apiKey);
  const run = openRuns.find(r => r.issueId === issueNumber);
  if (!run) {
    console.error(`No open run found for issue #${issueNumber}`);
    process.exit(1);
  }

  try {
    const { nextAct } = await executeTrigger(
      warp, apiKey,
      { graph: GRAPH, triggers: TRIGGERS, states: STATES },
      run, 'reset',
      { phase: phaseOverride },
    );

    console.log(`Reset issue #${issueNumber} → ${nextAct.name}`);
    console.log(`  Run: ${run.id}`);
    console.log(`  Opts: ${JSON.stringify(nextAct.opts)}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
