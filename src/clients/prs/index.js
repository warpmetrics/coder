// PR client factory — creates the appropriate PR adapter.

import { create as createGitHub } from './github.js';

const providers = {
  github: createGitHub,
};

export function createPRClient(config) {
  const provider = config?.codehost?.provider || 'github';
  const factory = providers[provider];
  if (!factory) {
    throw new Error(`Unknown PR provider: ${provider}. Available: ${Object.keys(providers).join(', ')}`);
  }
  return factory({ reviewToken: config?.reviewToken });
}
