#!/usr/bin/env node
// Recover a stuck issue run by re-emitting an Await Deploy act.
// Usage: node scripts/recover-deploy.js <runId> <deployGroupId> [--skip-warp]
//
// Example:
//   node scripts/recover-deploy.js wm_run_01khy9mp8w8k2qhsp8zp9xz49d wm_grp_01khye4b2b1srgc0cz4n6y9rg6

import { readFileSync } from 'fs';
import { join } from 'path';
import { recordIssueOutcome, emitAct } from '../src/client/warp.js';
import { OUTCOMES, ACTS } from '../src/names.js';
import { loadConfig } from '../src/config.js';

const [,, runId, deployGroupId, ...flags] = process.argv;
const skipWarp = flags.includes('--skip-warp');

if (!runId || !deployGroupId) {
  console.error('Usage: node scripts/recover-deploy.js <runId> <deployGroupId> [--skip-warp]');
  process.exit(1);
}

const config = loadConfig(process.cwd());
const apiKey = config.warpmetricsApiKey;
if (!apiKey) {
  console.error('No API key found. Set WARP_CODER_WARPMETRICS_KEY in .env');
  process.exit(1);
}

// The act opts from the original deploy (issue #147)
const actOpts = {
  prs: [
    { repo: 'warpmetrics/frontend', prNumber: 150 },
    { repo: 'warpmetrics/api', prNumber: 23 },
    ...(skipWarp ? [] : [{ repo: 'warpmetrics/warp', prNumber: 12 }]),
  ],
  release: [
    { repo: 'warpmetrics/frontend', command: 'npm run deploy:prod' },
    { repo: 'warpmetrics/api', command: 'npm run deploy:prod' },
    ...(skipWarp ? [] : [{ repo: 'warpmetrics/warp', command: 'npm run release:patch' }]),
  ],
};

console.log('Recovering deploy for run:', runId);
console.log('Deploy group:', deployGroupId);
console.log('Skip warp:', skipWarp);
console.log('Act opts:', JSON.stringify(actOpts, null, 2));

// 1. Record AWAITING_DEPLOY on the deploy group
const { outcomeId } = await recordIssueOutcome(apiKey, {
  runId: deployGroupId,
  name: OUTCOMES.AWAITING_DEPLOY,
});
console.log('Recorded AWAITING_DEPLOY:', outcomeId);

// 2. Emit Await Deploy act
const { actId } = await emitAct(apiKey, {
  outcomeId,
  name: ACTS.AWAIT_DEPLOY,
  opts: actOpts,
});
console.log('Emitted Await Deploy act:', actId);
console.log('Done — runner will pick this up on next poll cycle.');
