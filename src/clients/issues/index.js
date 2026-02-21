// Issue client factory — creates the appropriate issue tracker adapter.

import { create as createGitHub } from './github.js';

const providers = {
  github: createGitHub,
};

export function createIssueClient(config) {
  const provider = config?.issues?.provider || config?.codehost?.provider || 'github';
  const factory = providers[provider];
  if (!factory) {
    throw new Error(`Unknown issue provider: ${provider}. Available: ${Object.keys(providers).join(', ')}`);
  }
  return factory(config?.issues);
}
