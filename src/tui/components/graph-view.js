import { createElement as h, memo } from 'react';
import { Box, Text } from 'ink';
import { resolvePosition } from '../layout.js';

export const GraphView = memo(function GraphView({ phases, run, step }) {
  const { activePhase, activeAct, completedPhases } = resolvePosition(phases, run);

  const parts = [];

  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const isDone = completedPhases.has(phase.name);
    const isActive = phase.name === activePhase;

    if (i > 0) {
      parts.push(h(Text, { key: `s${i}`, dimColor: true }, ' \u2500 '));
    }

    const marker = isDone ? '\u2713' : isActive ? '\u25CF' : '\u25CB';
    const color = isDone ? 'green' : isActive ? 'yellow' : undefined;
    const dim = !isDone && !isActive;

    parts.push(
      h(Text, { key: `p${i}`, color, dimColor: dim, bold: isActive },
        `${marker} ${phase.label}`,
      ),
    );

    // Show current act under active phase.
    if (isActive) {
      const currentAct = phase.acts.find(a => a.name === activeAct);
      const actLabel = currentAct?.label || activeAct || '';
      if (actLabel && actLabel !== phase.label) {
        parts.push(h(Text, { key: `a${i}`, color: 'yellow' }, ` (${actLabel})`));
      }
      if (step) {
        parts.push(h(Text, { key: `st${i}`, dimColor: true }, ` \u2026${step}`));
      }
    }
  }

  return h(Box, { paddingLeft: 2 }, ...parts);
});
