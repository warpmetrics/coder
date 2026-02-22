// Changelog provider — abstracts where changelog entries are stored.
// Providers: "warpmetrics" (POST to API), "file" (write to local JSON files).

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TIMEOUTS } from '../../defaults.js';
import { CHANGELOG_ENTRY_SCHEMA, ChangelogEntrySchema } from './prompt.js';

// ---------------------------------------------------------------------------
// Entry generation (shared helper)
// ---------------------------------------------------------------------------

export async function generateChangelogEntry(claudeCode, prompt) {
  try {
    const res = await claudeCode.run({ prompt, jsonSchema: CHANGELOG_ENTRY_SCHEMA, maxTurns: 10, noSessionPersistence: true, allowedTools: '', timeout: TIMEOUTS.CLAUDE_QUICK, verbose: false });

    // Prefer structured output from the schema.
    let parsed = res.structuredOutput;
    if (!parsed) {
      // Fallback: parse from text.
      const raw = typeof res.result === 'string' ? (() => { try { const m = res.result.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; } catch { return null; } })() : res.result;
      const validated = ChangelogEntrySchema.safeParse(raw);
      parsed = validated?.success ? validated.data : null;
    }

    if (!parsed?.title || !parsed?.entry) return null;
    return { ...parsed, costUsd: res.costUsd };
  } catch (err) {
    console.error(`[changelog] generateChangelogEntry error: ${err.message}`);
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
