// Changelog provider — abstracts where changelog entries are stored.
// Providers: "warpmetrics" (POST to API), "file" (write to local JSON files).

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { PUBLIC_CHANGELOG as PUBLIC_PROMPT, PRIVATE_CHANGELOG as PRIVATE_PROMPT } from '../../prompts.js';

export { PUBLIC_PROMPT, PRIVATE_PROMPT };

// ---------------------------------------------------------------------------
// Entry generation (shared helper)
// ---------------------------------------------------------------------------

export function generateChangelogEntry(execFileSync, prompt, { model = 'sonnet' } = {}) {
  try {
    const result = execFileSync('claude', [
      '-p', prompt,
      '--max-turns', '1',
      '--model', model,
      '--no-session-persistence',
    ], { encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.title || !parsed.summary || !parsed.content) return null;
    return parsed;
  } catch (err) {
    const stderr = err.stderr?.toString?.() || '';
    console.log(`  changelog entry generation error: ${err.message}${stderr ? `\n  stderr: ${stderr.slice(0, 500)}` : ''}`);
    return null;
  }
}

export function createChangelogProvider(config) {
  const changelog = config.changelog;
  if (!changelog?.provider) return null;

  if (changelog.provider === 'warpmetrics') {
    return createWarpmetricsProvider(changelog);
  }

  if (changelog.provider === 'file') {
    return createFileProvider(changelog);
  }

  return null;
}

function createWarpmetricsProvider({ url, token }) {
  const apiUrl = url || 'https://api.warpmetrics.com';

  return {
    async post({ title, summary, content, visibility, tags }) {
      const res = await fetch(`${apiUrl}/v1/changelog`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title, summary, content, visibility, tags }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Changelog API ${res.status}: ${text}`);
      }

      const data = await res.json();
      return data.data;
    },
  };
}

function createFileProvider({ path: dir }) {
  const outDir = dir || './changelogs';

  return {
    async post({ title, summary, content, visibility, tags }) {
      mkdirSync(outDir, { recursive: true });

      // Append to a JSONL file per visibility
      const file = join(outDir, `${visibility}.jsonl`);
      const entry = {
        title,
        summary,
        content,
        visibility,
        tags,
        createdAt: new Date().toISOString(),
      };
      writeFileSync(file, JSON.stringify(entry) + '\n', { flag: 'a' });
      return entry;
    },
  };
}
