// Agent pipeline — shared helpers for WarpMetrics instrumentation.
// Zero external dependencies — uses Node built-ins + global fetch.

import crypto from 'crypto';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const API_URL = 'https://api.warpmetrics.com';
const STATE_FILE = '.pipeline-state.json';

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generateId(prefix) {
  const t = Date.now().toString(36).padStart(10, '0');
  const r = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `wm_${prefix}_${t}${r}`;
}

// ---------------------------------------------------------------------------
// WarpMetrics Events API (same wire format as @warpmetrics/warp)
// ---------------------------------------------------------------------------

export async function sendEvents(apiKey, batch) {
  const full = {
    runs: batch.runs || [],
    groups: batch.groups || [],
    calls: batch.calls || [],
    links: batch.links || [],
    outcomes: batch.outcomes || [],
    acts: batch.acts || [],
  };

  const raw = JSON.stringify(full);
  const body = JSON.stringify({ d: Buffer.from(raw, 'utf-8').toString('base64') });

  const res = await fetch(`${API_URL}/v1/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Events API ${res.status}: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// WarpMetrics Query API
// ---------------------------------------------------------------------------

export async function findRuns(apiKey, label, { limit = 20 } = {}) {
  const params = new URLSearchParams({ label, limit: String(limit) });
  const res = await fetch(`${API_URL}/v1/runs?${params}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.data || [];
}

// ---------------------------------------------------------------------------
// Outcome classifications (idempotent PUT)
// ---------------------------------------------------------------------------

export async function registerClassifications(apiKey) {
  const items = [
    { name: 'PR Created', classification: 'success' },
    { name: 'Fixes Applied', classification: 'success' },
    { name: 'Issue Understood', classification: 'success' },
    { name: 'Needs Clarification', classification: 'neutral' },
    { name: 'Needs Human', classification: 'neutral' },
    { name: 'Implementation Failed', classification: 'failure' },
    { name: 'Tests Failed', classification: 'failure' },
    { name: 'Revision Failed', classification: 'failure' },
    { name: 'Max Retries', classification: 'failure' },
  ];

  for (const { name, classification } of items) {
    try {
      await fetch(`${API_URL}/v1/outcomes/classifications/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ classification }),
      });
    } catch {
      // Best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-step state
// ---------------------------------------------------------------------------

export function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
}
