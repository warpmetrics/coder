// Agent pipeline — record an outcome after the agent step.

import { generateId, sendEvents, loadState } from './pipeline.js';

const apiKey = process.env.WARPMETRICS_API_KEY;
const status = process.env.STATUS; // "success" or "failure"
const step = process.env.STEP;

if (!apiKey) process.exit(0);

const state = loadState();
if (!state) {
  console.warn('No pipeline state — skipping outcome');
  process.exit(0);
}

const names = {
  implement: { success: 'PR Created', failure: 'Implementation Failed' },
  revise: { success: 'Fixes Applied', failure: 'Revision Failed' },
};

const name = names[step]?.[status] || `${step}: ${status}`;
const id = generateId('oc');
const now = new Date().toISOString();

try {
  await sendEvents(apiKey, {
    outcomes: [{ id, refId: state.groupId, name, opts: { status, step }, timestamp: now }],
  });
  console.log(`Outcome: ${name} (${id})`);
} catch (err) {
  console.warn(`Failed to record outcome: ${err.message}`);
}
