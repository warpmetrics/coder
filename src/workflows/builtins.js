// Builtins factory — provides all defaults for selective override
// in custom workflow definitions.

import { GRAPH, STATES, TRIGGERS, CHECKPOINTS } from '../graph/machine.js';
import { OUTCOMES, ACTS } from '../graph/names.js';
import { createDefaultExecutors, createDefaultEffects, defaultExecutorDefs } from './default.js';

export function createBuiltins() {
  return {
    graph: GRAPH,
    states: STATES,
    triggers: TRIGGERS,
    checkpoints: CHECKPOINTS,
    executors: createDefaultExecutors(),
    executorDefs: defaultExecutorDefs,
    effects: createDefaultEffects(),
    OUTCOMES,
    ACTS,
  };
}
