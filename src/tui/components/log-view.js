import { createElement as h, memo } from 'react';
import { Box, Text } from 'ink';

export const LogView = memo(function LogView({ logs, scrollOffset, maxRows, cols }) {
  if (logs.length === 0) {
    return h(Box, { flexDirection: 'column', height: maxRows },
      h(Text, { dimColor: true }, '  No logs yet.'),
    );
  }

  const start = Math.max(0, logs.length - maxRows - scrollOffset);
  const end = Math.max(0, logs.length - scrollOffset);
  const visible = logs.slice(start, end);
  const maxMsg = cols - 12;

  const children = [];
  for (let i = 0; i < visible.length; i++) {
    const entry = visible[i];
    const prefix = entry.issueId ? `#${entry.issueId} ` : '';
    children.push(
      h(Box, { key: `${start + i}` },
        h(Text, { dimColor: true }, ` ${entry.time} `),
        entry.issueId
          ? h(Text, null,
              h(Text, { color: 'cyan' }, `#${entry.issueId} `),
              h(Text, null, entry.msg.slice(0, maxMsg - prefix.length)),
            )
          : h(Text, { dimColor: true }, entry.msg.slice(0, maxMsg)),
      ),
    );
  }

  if (scrollOffset > 0) {
    children.push(h(Text, { key: 'si', dimColor: true }, `  \u2191 ${scrollOffset} more below`));
  }

  return h(Box, { flexDirection: 'column', height: maxRows }, ...children);
});
