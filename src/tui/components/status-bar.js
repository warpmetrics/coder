import { createElement as h, memo } from 'react';
import { Box, Text } from 'ink';

const HINTS = {
  main: 'j/k:move  tab/1-3:view  l:logs  r:repoll',
  logs: 'esc:back  j/k:scroll  r:repoll',
};

export const StatusBar = memo(function StatusBar({ view, cols, dividerPos }) {
  let sep;
  if (view === 'main' && dividerPos != null && dividerPos > 0 && dividerPos < cols - 1) {
    sep = '\u2500'.repeat(dividerPos) + '\u2534' + '\u2500'.repeat(cols - dividerPos - 1);
  } else {
    sep = '\u2500'.repeat(cols);
  }

  return h(Box, { flexDirection: 'column', width: cols },
    h(Text, { dimColor: true }, sep),
    h(Text, { dimColor: true }, ` ${HINTS[view] || ''}`),
  );
});
