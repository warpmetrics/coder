// Pure state machine for issue lifecycle.
// Zero I/O — every mapping is testable data.
//
// GRAPH is the single source of truth. All other exports are derived from it.
// Loaded from graphs/issue.yaml via the YAML compiler.

import { loadGraph } from './index.js';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const { graph: GRAPH, states: STATES, triggers: TRIGGERS, checkpoints: CHECKPOINTS } = loadGraph(join(__dirname, '../../graphs/issue.yaml'));
