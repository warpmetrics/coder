import * as claude from './claude.js';
import { loadMemory, saveMemory } from './memory.js';

// Serialize concurrent reflect calls so memory file doesn't get corrupted
let lock = Promise.resolve();

export function reflect(args) {
  const p = lock.then(() => _reflect(args));
  lock = p.catch(() => {}); // lock advances even on error
  return p;
}

async function _reflect({ configDir, step, issue, prNumber, success, error, hookOutputs, reviewComments, claudeOutput, maxLines = 100 }) {
  const currentMemory = loadMemory(configDir);

  const sections = [
    '# Reflect on this task and update the memory file.',
    '',
    `Step: ${step}`,
    `Outcome: ${success ? 'success' : 'failure'}`,
  ];

  if (issue) sections.push(`Issue: #${issue.number} — ${issue.title}`);
  if (prNumber) sections.push(`PR: #${prNumber}`);

  if (error) {
    sections.push('', '## Error', '```', truncate(error, 500), '```');
  }

  if (hookOutputs?.length) {
    sections.push('', '## Hook outputs');
    for (const h of hookOutputs) {
      sections.push(`### ${h.hook} (exit ${h.exitCode})`);
      const output = (h.stdout + h.stderr).trim();
      if (output) sections.push('```', truncate(output, 1000), '```');
    }
  }

  if (reviewComments?.length) {
    sections.push('', '## Review comments');
    for (const c of reviewComments) {
      sections.push(`- ${c.user?.login || 'reviewer'}: ${truncate(c.body || '', 200)}`);
    }
  }

  if (claudeOutput) {
    sections.push('', '## Claude output (truncated)', '```', truncate(String(claudeOutput), 1000), '```');
  }

  const prompt = [
    'You are a memory manager for an automated coding agent.',
    '',
    `Here is the agent's current memory file (lessons learned from past tasks):`,
    '',
    currentMemory ? '```\n' + currentMemory + '\n```' : '(no memory yet)',
    '',
    'Here is what just happened:',
    '',
    sections.join('\n'),
    '',
    'Instructions:',
    `- Output the COMPLETE updated memory file (markdown).`,
    `- Keep it under ${maxLines} lines.`,
    `- Preserve relevant existing lessons. Add new ones from this task.`,
    `- Remove lessons that are contradicted by new evidence.`,
    `- Be concise — each lesson should be 1-2 lines max.`,
    `- Group lessons by topic (e.g. "## Testing", "## Code patterns").`,
    `- Output ONLY the memory file content, no explanation.`,
  ].join('\n');

  const result = await claude.run({
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

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '\n... (truncated)';
}
