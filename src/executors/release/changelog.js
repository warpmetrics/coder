// Changelog provider — abstracts where changelog entries are stored.
// Providers: "warpmetrics" (POST to API), "file" (write to local JSON files).

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Entry generation (shared helper)
// ---------------------------------------------------------------------------

export async function generateChangelogEntry(claudeCode, prompt) {
  try {
    const { result, costUsd } = await claudeCode.run({ prompt, maxTurns: 1, noSessionPersistence: true, allowedTools: '', timeout: 60000, verbose: false });

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.title || !parsed.entry) return null;
    return { ...parsed, costUsd };
  } catch (err) {
    console.log(`  changelog entry generation error: ${err.message}`);
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
    async post({ title, publicEntry, privateEntry, publicEntryVisible, tags }) {
      const res = await fetch(`${apiUrl}/v1/changelog`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title, publicEntry, privateEntry, publicEntryVisible, tags }),
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
    async post({ title, publicEntry, privateEntry, publicEntryVisible, tags }) {
      mkdirSync(outDir, { recursive: true });

      const file = join(outDir, 'changelog.jsonl');
      const entry = {
        title,
        publicEntry,
        privateEntry,
        publicEntryVisible,
        tags,
        createdAt: new Date().toISOString(),
      };
      writeFileSync(file, JSON.stringify(entry) + '\n', { flag: 'a' });
      return entry;
    },
  };
}
