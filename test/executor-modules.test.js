import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GRAPH } from '../src/machine.js';
import { defaultExecutorDefs, createDefaultExecutors } from '../src/workflows/default.js';

// ---------------------------------------------------------------------------
// Executor module contract tests
// ---------------------------------------------------------------------------

describe('executor module contract', () => {

  it('every default executor def has name, resultTypes, create', () => {
    for (const def of defaultExecutorDefs) {
      assert.equal(typeof def.name, 'string', `def must have a string name`);
      assert.ok(Array.isArray(def.resultTypes), `${def.name}: resultTypes must be an array`);
      assert.ok(def.resultTypes.length > 0, `${def.name}: resultTypes must not be empty`);
      assert.equal(typeof def.create, 'function', `${def.name}: create must be a function`);
    }
  });

  it('every default executor def name is unique', () => {
    const names = defaultExecutorDefs.map(d => d.name);
    assert.equal(new Set(names).size, names.length, 'executor names must be unique');
  });

  it('create() returns a function for every default executor', () => {
    for (const def of defaultExecutorDefs) {
      const fn = def.create();
      assert.equal(typeof fn, 'function', `${def.name}: create() must return a function`);
    }
  });

  it('createDefaultExecutors() produces same names as executor defs', () => {
    const executors = createDefaultExecutors();
    const defNames = new Set(defaultExecutorDefs.map(d => d.name));
    const execNames = new Set(Object.keys(executors));
    assert.deepEqual(execNames, defNames, 'executor map keys should match def names');
  });

  it('every executor in GRAPH has a matching default executor def', () => {
    const defNames = new Set(defaultExecutorDefs.map(d => d.name));
    for (const [act, node] of Object.entries(GRAPH)) {
      if (node.executor === null) continue;
      assert.ok(defNames.has(node.executor), `GRAPH act '${act}' references executor '${node.executor}' with no matching def`);
    }
  });

  it('every executor def resultTypes covers all graph result types', () => {
    const defsByName = new Map(defaultExecutorDefs.map(d => [d.name, d]));
    for (const [act, node] of Object.entries(GRAPH)) {
      if (node.executor === null) continue;
      const def = defsByName.get(node.executor);
      if (!def) continue;
      for (const resultType of Object.keys(node.results)) {
        assert.ok(
          def.resultTypes.includes(resultType),
          `Executor '${node.executor}' missing result type '${resultType}' required by act '${act}'`
        );
      }
    }
  });

  it('no executor def declares result types not used in the graph', () => {
    // Collect all result types per executor from graph.
    const graphResultTypes = new Map();
    for (const node of Object.values(GRAPH)) {
      if (node.executor === null) continue;
      if (!graphResultTypes.has(node.executor)) {
        graphResultTypes.set(node.executor, new Set());
      }
      for (const rt of Object.keys(node.results)) {
        graphResultTypes.get(node.executor).add(rt);
      }
    }

    for (const def of defaultExecutorDefs) {
      const expected = graphResultTypes.get(def.name);
      if (!expected) continue;
      for (const rt of def.resultTypes) {
        assert.ok(expected.has(rt), `Executor '${def.name}' declares unused result type '${rt}'`);
      }
    }
  });
});
