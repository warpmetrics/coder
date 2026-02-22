import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { compileGraph } from './compile.js';

export { compileGraph };
export { validateGraph, buildTransitionGraph, findReachableActs, findOrphanOutcomes } from './validate.js';

export function normalizeOutcomes(outcomes) {
  return Array.isArray(outcomes) ? outcomes : [outcomes];
}

export function loadGraph(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const doc = parse(raw);
  return compileGraph(doc);
}
