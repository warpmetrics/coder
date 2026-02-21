// Default workflow executors and effects.
// Executors are defined as modules with { name, resultTypes, create }.

import { definition as implementDef } from '../executors/implement/index.js';
import { definition as reviewDef } from '../executors/review/index.js';
import { definition as reviseDef } from '../executors/revise/index.js';
import { definition as mergeDef } from '../executors/merge/index.js';
import { definition as deployDef } from '../executors/deploy/index.js';
import { definition as releaseDef } from '../executors/release/index.js';
import { definition as awaitDeployDef } from '../executors/await_deploy/index.js';
import { definition as awaitReplyDef } from '../executors/await_reply/index.js';

export const defaultExecutorDefs = [
  implementDef, reviewDef, reviseDef, mergeDef,
  deployDef, releaseDef, awaitDeployDef, awaitReplyDef,
];

export function createDefaultExecutors() {
  const executors = {};
  for (const def of defaultExecutorDefs) {
    executors[def.name] = def.create();
  }
  return executors;
}

export function createDefaultEffects() {
  const effects = {};
  for (const def of defaultExecutorDefs) {
    for (const [key, fn] of Object.entries(def.effects || {})) {
      effects[`${def.name}:${key}`] = fn;
    }
  }
  return effects;
}
