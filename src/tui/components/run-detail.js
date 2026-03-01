import { createElement as h, memo, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { resolvePosition, classifyOutcome, formatElapsed, runTitle } from '../layout.js';

// ---------------------------------------------------------------------------
// Phase state resolution (shared with run-list)
// ---------------------------------------------------------------------------

function phaseStates(phases, run) {
  if (phases.length === 0) return [];

  if (run.pendingAct) {
    const { activePhase, completedPhases } = resolvePosition(phases, run);
    return phases.map(p => {
      if (completedPhases.has(p.name)) return 'done';
      if (p.name === activePhase) return 'active';
      return 'pending';
    });
  }

  const cls = classifyOutcome(run.latestOutcome);
  let lastIdx = 0;
  if (run.groupOutcomes) {
    for (let i = phases.length - 1; i >= 0; i--) {
      if (run.groupOutcomes.get(phases[i].label)?.length > 0) {
        lastIdx = i;
        break;
      }
    }
  }

  return phases.map((_, i) => {
    if (i < lastIdx) return 'done';
    if (i === lastIdx) return cls === 'failure' ? 'failed' : 'active';
    return 'pending';
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stateColor(s) {
  if (s === 'done') return 'green';
  if (s === 'active') return 'yellow';
  if (s === 'failed') return 'red';
  return undefined;
}

function ocColor(c) {
  if (c === 'success') return 'green';
  if (c === 'failure') return 'red';
  if (c === 'waiting') return 'yellow';
  return undefined;
}

function ocMarker(c) {
  if (c === 'success') return '\u2713';
  if (c === 'failure') return '\u2717';
  if (c === 'waiting') return '\u25CF';
  return ' ';
}

const SKIP_OPTS = new Set(['status', 'step', 'version', 'name', 'repo', 'issue', 'title']);
const RENAME = { cost_usd: 'cost', pr_number: 'pr', review_comments: 'comments', session_id: 'session', deploy_attempts: 'attempts', hooks_failed: 'hooks' };

function formatOpts(opts) {
  if (!opts || typeof opts !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(opts)) {
    if (SKIP_OPTS.has(k) || v == null || v === '') continue;
    const label = RENAME[k] || k;
    let val = String(v);
    if (label === 'cost') val = `$${val}`;
    if (label === 'error' || label === 'err') val = val.slice(0, 50);
    if (label === 'session') val = val.slice(0, 10) + '\u2026';
    parts.push(`${label}:${val}`);
  }
  return parts.join('  ');
}

function totalCost(run) {
  let total = 0;
  for (const oc of (run.outcomes || [])) {
    if (oc.opts?.cost_usd) total += parseFloat(oc.opts.cost_usd) || 0;
  }
  if (run.groupOutcomes) {
    for (const [, ocs] of run.groupOutcomes) {
      for (const oc of ocs) {
        if (oc.opts?.cost_usd) total += parseFloat(oc.opts.cost_usd) || 0;
      }
    }
  }
  return total > 0 ? total.toFixed(2) : null;
}

function pad(s, w) {
  if (s.length >= w) return s.slice(0, w);
  return s + ' '.repeat(w - s.length);
}

// ---------------------------------------------------------------------------
// Tab: Pipeline
// ---------------------------------------------------------------------------

function renderPipeline(run, phases, contentRows, cols) {
  const states = phaseStates(phases, run);
  const lines = [];

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const state = states[i];
    const marker = state === 'done' ? '\u2713' : state === 'active' ? '\u25CF' : state === 'failed' ? '\u2717' : '\u25CB';
    const color = stateColor(state);

    lines.push(h(Box, { key: `ph${i}` },
      h(Text, { color, bold: state === 'active' }, ` ${marker} ${phase.label}`),
    ));

    // Show outcomes for active/completed/failed phases.
    if (state !== 'pending') {
      const phaseOcs = run.groupOutcomes?.get(phase.label) || [];
      for (let j = 0; j < phaseOcs.length; j++) {
        const oc = phaseOcs[j];
        const cls = classifyOutcome(oc.name);
        const m = ocMarker(cls);
        const optsStr = formatOpts(oc.opts);

        lines.push(h(Box, { key: `oc${i}-${j}` },
          h(Text, { dimColor: true }, ' \u2502 '),
          h(Text, { color: ocColor(cls) }, `${m} ${oc.name}`),
          optsStr ? h(Text, { dimColor: true }, `  ${optsStr}`) : null,
        ));
      }

      // Connector.
      if (phaseOcs.length > 0 && i < phases.length - 1) {
        lines.push(h(Text, { key: `sep${i}`, dimColor: true }, ' \u2502'));
      }
    }
  }

  // Truncate to fit.
  return lines.slice(0, contentRows);
}

// ---------------------------------------------------------------------------
// Tab: Timeline
// ---------------------------------------------------------------------------

function buildTimeline(outcomes, groupOutcomes) {
  const timeline = [];
  for (const oc of (outcomes || [])) {
    timeline.push({ ...oc, _source: 'run' });
  }
  if (groupOutcomes) {
    for (const [label, ocs] of groupOutcomes) {
      for (const oc of ocs) {
        timeline.push({ ...oc, _source: label });
      }
    }
  }
  timeline.sort((a, b) => {
    if (a.createdAt && b.createdAt) return new Date(a.createdAt) - new Date(b.createdAt);
    return 0;
  });
  return timeline;
}

function renderTimeline(run, contentRows, cols) {
  const timeline = buildTimeline(run.outcomes, run.groupOutcomes);
  const lines = [];

  // Show latest entries that fit.
  const entries = [];
  for (const oc of timeline) {
    entries.push({ type: 'outcome', oc });
    if (oc.acts?.length) {
      for (const a of oc.acts) {
        entries.push({ type: 'act', act: a });
      }
    }
  }

  const start = Math.max(0, entries.length - contentRows);

  for (let i = start; i < entries.length; i++) {
    const entry = entries[i];

    if (entry.type === 'outcome') {
      const oc = entry.oc;
      const time = oc.createdAt
        ? new Date(oc.createdAt).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : '        ';
      const cls = classifyOutcome(oc.name);
      const optsStr = formatOpts(oc.opts);

      lines.push(h(Box, { key: `tl${i}` },
        h(Text, { dimColor: true }, ` ${time}  `),
        h(Text, { color: ocColor(cls) }, oc.name),
        optsStr ? h(Text, { dimColor: true }, `  ${optsStr}`) : null,
      ));
    } else {
      const a = entry.act;
      const optsStr = formatOpts(a.opts);

      lines.push(h(Box, { key: `ta${i}` },
        h(Text, { dimColor: true }, '           \u2192 '),
        h(Text, null, a.name),
        optsStr ? h(Text, { dimColor: true }, `  ${optsStr}`) : null,
      ));
    }
  }

  if (lines.length === 0) {
    lines.push(h(Text, { key: 'empty', dimColor: true }, ' No outcomes yet.'));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Tab: Logs
// ---------------------------------------------------------------------------

function renderRunLogs(logs, issueId, contentRows, cols) {
  const filtered = logs.filter(l => l.issueId === issueId);
  const start = Math.max(0, filtered.length - contentRows);
  const lines = [];

  for (let i = start; i < filtered.length; i++) {
    const l = filtered[i];
    lines.push(h(Text, { key: `log${i}`, dimColor: true },
      ` ${l.time}  ${l.msg}`,
    ));
  }

  if (lines.length === 0) {
    lines.push(h(Text, { key: 'empty', dimColor: true }, ' No logs for this run.'));
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const BAR_W = 8;

export const RunDetail = memo(function RunDetail({ run, phases, steps, logs, tab, maxRows, cols }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!run) {
    return h(Box, { flexDirection: 'column', height: maxRows },
      h(Text, { dimColor: true }, ' No run selected.'),
    );
  }

  const title = runTitle(run);
  const states = phaseStates(phases, run);
  const step = steps.get(run.issueId);
  const elapsed = step ? formatElapsed(Date.now() - step.startedAt) : '';
  const cost = totalCost(run);

  // Current phase.
  let curPhaseLabel = '';
  let curPhaseState = 'pending';
  for (let p = phases.length - 1; p >= 0; p--) {
    if (states[p] === 'active' || states[p] === 'failed') {
      curPhaseLabel = phases[p].label;
      curPhaseState = states[p];
      break;
    }
  }

  // Status text.
  const statusText = step?.step || run.latestOutcome || '';

  // Build progress bar.
  const barParts = [];
  let prevState = null;
  let chunk = '';
  for (let b = 0; b < BAR_W; b++) {
    const pIdx = Math.floor(b * phases.length / BAR_W);
    const state = states[pIdx] || 'pending';
    if (state !== prevState && chunk) {
      barParts.push({ chars: chunk, state: prevState });
      chunk = '';
    }
    chunk += state === 'pending' ? '\u2591' : '\u2588';
    prevState = state;
  }
  if (chunk) barParts.push({ chars: chunk, state: prevState });

  const barElements = barParts.map((bp, idx) =>
    h(Text, { key: `b${idx}`, color: stateColor(bp.state), dimColor: bp.state === 'pending' }, bp.chars)
  );

  // Header lines.
  const headerLines = [];

  // Line 1: issue + title + repo.
  const tTitle = title.length > cols - 15 ? title.slice(0, cols - 18) + '\u2026' : title;
  headerLines.push(h(Box, { key: 'h1', justifyContent: 'space-between', width: cols },
    h(Box, null,
      h(Text, { bold: true, color: 'cyan' }, ` #${run.issueId} `),
      h(Text, { bold: true }, tTitle),
    ),
    run.repo ? h(Text, { dimColor: true }, `${run.repo} `) : null,
  ));

  // Line 2: bar + phase · status + cost + time.
  headerLines.push(h(Box, { key: 'h2', justifyContent: 'space-between', width: cols },
    h(Box, null,
      h(Text, null, ' '),
      ...barElements,
      h(Text, null, ' '),
      h(Text, { color: stateColor(curPhaseState), bold: !!step }, curPhaseLabel),
      h(Text, { dimColor: true }, ' \u00B7 '),
      h(Text, { color: ocColor(classifyOutcome(run.latestOutcome)) }, statusText),
    ),
    h(Box, null,
      cost ? h(Text, { dimColor: true }, `$${cost}  `) : null,
      elapsed ? h(Text, { dimColor: true }, `${elapsed} `) : null,
    ),
  ));

  // Line 3: tab bar.
  const TABS = [
    { key: 'pipeline', label: 'pipeline', num: '1' },
    { key: 'timeline', label: 'timeline', num: '2' },
    { key: 'logs', label: 'logs', num: '3' },
  ];
  const tabElements = TABS.map((t, i) => {
    const active = t.key === tab;
    return h(Text, { key: t.key, bold: active, dimColor: !active, underline: active },
      `${i > 0 ? '  ' : ' '}${t.num}:${t.label}`,
    );
  });
  headerLines.push(h(Box, { key: 'tabs' }, ...tabElements));

  const contentRows = maxRows - headerLines.length;

  // Tab content.
  let content;
  if (tab === 'pipeline') {
    content = renderPipeline(run, phases, contentRows, cols);
  } else if (tab === 'timeline') {
    content = renderTimeline(run, contentRows, cols);
  } else {
    content = renderRunLogs(logs || [], run.issueId, contentRows, cols);
  }

  return h(Box, { flexDirection: 'column', height: maxRows },
    ...headerLines,
    ...content,
  );
});
