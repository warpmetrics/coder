// CodeHost factory — creates the appropriate codehost adapter.

import { create as createGitHub } from './github.js';

const providers = {
  github: createGitHub,
};

export function createCodeHost(config) {
  // Default to github — currently the only provider
  const provider = config?.codehost?.provider || 'github';
  const factory = providers[provider];
  if (!factory) {
    throw new Error(`Unknown codehost provider: ${provider}. Available: ${Object.keys(providers).join(', ')}`);
  }
  return factory({ ...config?.codehost, reviewToken: config?.reviewToken });
}
