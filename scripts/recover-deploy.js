#!/usr/bin/env node
// Recover a stuck issue run by re-emitting an Await Deploy act.
// Usage: node scripts/recover-deploy.js <runId> <deployGroupId> --prs '<json>' --release '<json>'
//
// Example:
//   node scripts/recover-deploy.js wm_run_xxx wm_grp_xxx \
//     --prs '[{"repo":"warpmetrics/frontend","prNumber":160}]' \
//     --release '[{"repo":"warpmetrics/frontend","command":"npm run deploy:prod"}]'

import { recordIssueOutcome, emitAct } from '../src/clients/warp.js';
import { OUTCOMES, ACTS } from '../src/names.js';
import { loadConfig } from '../src/config.js';

const args = process.argv.slice(2);
const runId = args[0];
const deployGroupId = args[1];

function flag(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}

if (!runId || !deployGroupId) {
  console.error('Usage: node scripts/recover-deploy.js <runId> <deployGroupId> --prs \'<json>\' --release \'<json>\'');
  process.exit(1);
}

const prs = flag('--prs') ? JSON.parse(flag('--prs')) : [];
const release = flag('--release') ? JSON.parse(flag('--release')) : [];

if (prs.length === 0 || release.length === 0) {
  console.error('Both --prs and --release are required.');
  console.error('  --prs     \'[{"repo":"org/repo","prNumber":123}]\'');
  console.error('  --release \'[{"repo":"org/repo","command":"npm run deploy:prod"}]\'');
  process.exit(1);
}

const config = loadConfig(process.cwd());
const apiKey = config.warpmetricsApiKey;
if (!apiKey) {
  console.error('No API key found. Set WARP_CODER_WARPMETRICS_KEY in .env');
  process.exit(1);
}

const actOpts = { prs, release };

console.log('Recovering deploy for run:', runId);
console.log('Deploy group:', deployGroupId);
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
