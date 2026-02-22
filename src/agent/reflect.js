import { rawRun, buildTrace } from '../clients/claude-code.js';
import { loadMemory, saveMemory } from './memory.js';
import { buildReflectPrompt } from './prompt.js';
import { TIMEOUTS } from '../defaults.js';

// Serialize concurrent reflect calls so memory file doesn't get corrupted
let lock = Promise.resolve();

export function reflectOnStep(config, configDir, step, opts, log, claudeCode) {
  if (config.memory?.enabled === false) return;
  reflect({ configDir, step, ...opts, hookOutputs: (opts.hookOutputs || []).filter(h => h.ran), maxLines: config.memory?.maxLines || 100, claudeCode })
    .then(() => log('  reflect: memory updated'))
    .catch(() => {});
}

export function reflect(args) {
  const p = lock.then(() => _reflect(args));
  lock = p.catch(() => {}); // lock advances even on error
  return p;
}

async function _reflect({ configDir, step, issue, prNumber, success, error, hookOutputs, reviewComments, claudeOutput, maxLines = 100, claudeCode }) {
  const currentMemory = loadMemory(configDir);

  const prompt = buildReflectPrompt({
    currentMemory, step, issue, prNumber,
    success, error, hookOutputs, reviewComments, claudeOutput, maxLines,
  });

  let result;
  if (claudeCode) {
    result = await claudeCode.run({ prompt, maxTurns: 1, noSessionPersistence: true, allowedTools: '', timeout: TIMEOUTS.CLAUDE_QUICK, verbose: false });
  } else {
    result = await rawRun({
      prompt,
      workdir: process.cwd(),
      allowedTools: '',
      maxTurns: 1,
      noSessionPersistence: true,
      timeout: TIMEOUTS.CLAUDE_QUICK,
      verbose: false,
    });
  }

  const content = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
  saveMemory(configDir, content.trim() + '\n');
}
