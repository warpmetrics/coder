import { createElement as h, memo, useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { resolvePosition, classifyOutcome, formatElapsed, runTitle } from '../layout.js';

const SPIN = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];

// ---------------------------------------------------------------------------
// Phase state resolution
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

function pad(s, w) {
  if (s.length >= w) return s.slice(0, w);
  return s + ' '.repeat(w - s.length);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const RunList = memo(function RunList({ runs, phases, selectedIndex, steps, maxRows, cols }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (runs.length === 0) {
    return h(Box, { flexDirection: 'column', height: maxRows },
      h(Text, { dimColor: true }, ' Watching\u2026'),
    );
  }

  // Bar width: 4 for narrow panes, 8 for wider.
  const barW = cols > 50 ? 8 : 4;

  // Column widths: ▸ #NNN Title... ████
  const curW = 2;
  const idW = 6;
  const barSep = barW + 1;
  const fixedW = curW + idW + barSep;
  const titleW = Math.max(4, cols - fixedW);

  // Scroll window.
  let startIdx = 0;
  if (runs.length > maxRows) {
    startIdx = Math.max(0, selectedIndex - Math.floor(maxRows / 2));
    startIdx = Math.min(startIdx, runs.length - maxRows);
  }
  const endIdx = Math.min(startIdx + maxRows, runs.length);

  const children = [];

  for (let i = startIdx; i < endIdx; i++) {
    const run = runs[i];
    const sel = i === selectedIndex;

    const step = steps.get(run.issueId);
    const isActive = !!step;
    const spinner = isActive ? SPIN[tick % SPIN.length] : '';
    const title = runTitle(run);

    const states = phaseStates(phases, run);

    // Build bar.
    const barParts = [];
    let prevState = null;
    let chunk = '';
    for (let b = 0; b < barW; b++) {
      const pIdx = Math.floor(b * phases.length / barW);
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

    const idStr = `#${run.issueId}`;
    const prefix = spinner ? `${spinner} ` : '  ';
    const tTitle = title.length > titleW ? title.slice(0, titleW - 1) + '\u2026' : title;

    children.push(
      h(Box, { key: run.id },
        h(Text, { bold: sel }, sel ? '\u25B8 ' : prefix),
        h(Text, { bold: sel, color: 'cyan' }, pad(idStr, idW)),
        h(Text, { bold: sel, dimColor: !sel }, pad(tTitle, titleW)),
        ...barElements,
      ),
    );
  }

  // Scroll indicators.
  if (startIdx > 0) {
    children.unshift(h(Text, { key: 'up', dimColor: true }, `  \u2191 ${startIdx} more`));
    children.pop();
  }
  if (endIdx < runs.length) {
    children.push(h(Text, { key: 'dn', dimColor: true }, `  \u2193 ${runs.length - endIdx} more`));
    if (children.length > maxRows) children.splice(children.length - 2, 1);
  }

  return h(Box, { flexDirection: 'column', height: maxRows }, ...children);
});
