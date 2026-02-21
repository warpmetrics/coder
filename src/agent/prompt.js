// Prompt template for memory reflection.

export function buildReflectPrompt({ currentMemory, step, issue, prNumber, success, error, hookOutputs, reviewComments, claudeOutput, maxLines }) {
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

  return [
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
}

function truncate(str, maxLen) {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '\n... (truncated)';
}
