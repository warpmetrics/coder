// Notifier factory — builds a fan-out notifier from config.
// Dispatches to all configured channels (GitHub comments, Slack, etc.).

import { create as createGitHub } from './github.js';
import { create as createSlack } from './slack.js';

const providers = {
  github: createGitHub,
  slack: createSlack,
};

function formatBotComment(body, runId) {
  const header = runId
    ? `**warp-coder** · [run](https://warpmetrics.com/app/runs/${runId})`
    : '**warp-coder**';
  return `${header}\n\n---\n\n${body}`;
}

export function createNotifier(config) {
  const channelConfigs = config?.notify || [{ provider: config?.codehost?.provider || 'github' }];
  const channels = channelConfigs.map(c => {
    const factory = providers[c.provider];
    if (!factory) {
      throw new Error(`Unknown notify provider: ${c.provider}. Available: ${Object.keys(providers).join(', ')}`);
    }
    return factory(c);
  });

  return {
    comment(issueId, { body, runId, repo }) {
      const formatted = formatBotComment(body, runId);
      for (const ch of channels) {
        try { ch.comment(issueId, { body: formatted, repo }); } catch {}
      }
    },
  };
}
