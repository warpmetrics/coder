import { createElement as h, memo, useState, useEffect } from 'react';
import { Box, Text } from 'ink';

export const Header = memo(function Header({ lastPollAt, pollStats, cols, dividerPos }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const d = new Date();
  const clock = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const pollAgo = lastPollAt ? `${Math.round((Date.now() - lastPollAt) / 1000)}s` : '\u2026';
  const open = pollStats?.total || 0;
  const inflight = pollStats?.inFlight || 0;
  const stats = `${open} runs \u00B7 ${inflight} active \u00B7 poll ${pollAgo}`;

  let sep;
  if (dividerPos != null && dividerPos > 0 && dividerPos < cols - 1) {
    sep = '\u2500'.repeat(dividerPos) + '\u252C' + '\u2500'.repeat(cols - dividerPos - 1);
  } else {
    sep = '\u2500'.repeat(cols);
  }

  return h(Box, { flexDirection: 'column', width: cols },
    h(Box, { justifyContent: 'space-between', width: cols },
      h(Text, { dimColor: true }, ` ${stats}`),
      h(Text, { dimColor: true }, `${clock} `),
    ),
    h(Text, { dimColor: true }, sep),
  );
});

function p2(n) { return n < 10 ? '0' + n : '' + n; }
