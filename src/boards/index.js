import { create as createGitHubProjects } from './github-projects.js';

const providers = {
  'github-projects': createGitHubProjects,
};

export function createBoard(config) {
  const provider = config.board?.provider;
  const factory = providers[provider];
  if (!factory) {
    throw new Error(`Unknown board provider: ${provider}. Available: ${Object.keys(providers).join(', ')}`);
  }
  return factory(config.board);
}
