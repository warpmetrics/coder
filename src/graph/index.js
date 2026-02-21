import { readFileSync } from 'fs';
import { parse } from 'yaml';
import { compileGraph } from './compile.js';

export { compileGraph };

export function loadGraph(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const doc = parse(raw);
  return compileGraph(doc);
}
