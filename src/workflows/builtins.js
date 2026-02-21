// Builtins factory — provides all defaults for selective override
// in custom workflow definitions.

import { GRAPH, STATES } from '../machine.js';
import { OUTCOMES, ACTS } from '../names.js';
import { createDefaultExecutors, createDefaultEffects, defaultExecutorDefs } from './default.js';

export function createBuiltins() {
  return {
    graph: GRAPH,
    states: STATES,
    executors: createDefaultExecutors(),
    executorDefs: defaultExecutorDefs,
    effects: createDefaultEffects(),
    OUTCOMES,
    ACTS,
  };
}
