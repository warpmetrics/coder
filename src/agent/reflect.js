import { run } from '../executors/claude.js';
import { loadMemory, saveMemory } from './memory.js';
import { buildReflectPrompt } from './prompt.js';

// Serialize concurrent reflect calls so memory file doesn't get corrupted
let lock = Promise.resolve();

export function reflect(args) {
  const p = lock.then(() => _reflect(args));
  lock = p.catch(() => {}); // lock advances even on error
  return p;
}

async function _reflect({ configDir, step, issue, prNumber, success, error, hookOutputs, reviewComments, claudeOutput, maxLines = 100 }) {
  const currentMemory = loadMemory(configDir);

  const prompt = buildReflectPrompt({
    currentMemory, step, issue, prNumber,
    success, error, hookOutputs, reviewComments, claudeOutput, maxLines,
  });

  const result = await run({
    prompt,
    workdir: process.cwd(),
    allowedTools: '',
    maxTurns: 1,
    timeout: 60000, // 1 minute for reflection
    verbose: false,
  });

  const content = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
  saveMemory(configDir, content.trim() + '\n');
}

