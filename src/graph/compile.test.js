import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileGraph, loadGraph } from './index.js';
import { GRAPH as ORIGINAL_GRAPH, STATES as ORIGINAL_STATES } from './machine.js';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('compileGraph', () => {

  it('compiles a minimal single-act graph', () => {
    const doc = {
      MyAct: {
        executor: 'doWork',
        results: {
          success: { outcome: 'Done' },
        },
      },
      states: { Done: 'completed' },
    };
    const { graph, states } = compileGraph(doc);
    assert.deepStrictEqual(graph.MyAct, {
      label: 'MyAct',
      executor: 'doWork',
      results: {
        success: { outcomes: { name: 'Done' } },
      },
    });
    assert.deepStrictEqual(states, { Done: 'completed' });
  });

  it('compiles phase group with executor: null and created result', () => {
    const doc = {
      Phase: {
        executor: null,
        results: {
          created: { outcome: 'Starting', on: 'Phase', next: 'Work' },
        },
      },
      Work: {
        executor: 'work',
        parent: 'Phase',
        results: {
          success: { outcome: 'Finished' },
        },
      },
      states: { Starting: 'inProgress', Finished: 'done' },
    };
    const { graph } = compileGraph(doc);
    assert.strictEqual(graph.Phase.executor, null);
    assert.deepStrictEqual(graph.Phase.results.created.outcomes, {
      name: 'Starting', in: 'Phase', next: 'Work',
    });
  });

  it('maps parent to group', () => {
    const doc = {
      Phase: {
        executor: null,
        results: { created: { outcome: 'Go', on: 'Phase', next: 'Step' } },
      },
      Step: {
        executor: 'step',
        parent: 'Phase',
        results: { success: { outcome: 'Stepped' } },
      },
      states: { Go: 'inProgress', Stepped: 'done' },
    };
    const { graph } = compileGraph(doc);
    assert.strictEqual(graph.Step.group, 'Phase');
    assert.strictEqual(graph.Phase.group, undefined);
  });

  it('maps on to in', () => {
    const doc = {
      MyAct: {
        executor: 'doIt',
        results: {
          success: { outcome: 'OK', on: 'Issue' },
        },
      },
      states: { OK: 'done' },
    };
    const { graph } = compileGraph(doc);
    assert.strictEqual(graph.MyAct.results.success.outcomes.in, 'Issue');
    assert.strictEqual(graph.MyAct.results.success.outcomes.on, undefined);
  });

  it('normalizes single outcome (object) correctly', () => {
    const doc = {
      Act: {
        executor: 'run',
        results: { done: { outcome: 'Finished', on: 'Issue', next: 'Next' } },
      },
      Next: {
        executor: 'next',
        results: { done: { outcome: 'AllDone' } },
      },
      states: { Finished: 'done', AllDone: 'done' },
    };
    const { graph } = compileGraph(doc);
    assert.deepStrictEqual(graph.Act.results.done.outcomes, {
      name: 'Finished', in: 'Issue', next: 'Next',
    });
  });

  it('normalizes multiple outcomes (array) correctly', () => {
    const doc = {
      Phase: {
        executor: null,
        results: { created: { outcome: 'Go', on: 'Phase', next: 'Act' } },
      },
      Act: {
        executor: 'run',
        parent: 'Phase',
        results: {
          success: [
            { outcome: 'A', on: 'Phase' },
            { outcome: 'B', on: 'Issue', next: 'Phase' },
          ],
        },
      },
      states: { Go: 'inProgress', A: 'done', B: 'done' },
    };
    const { graph } = compileGraph(doc);
    assert.deepStrictEqual(graph.Act.results.success.outcomes, [
      { name: 'A', in: 'Phase' },
      { name: 'B', in: 'Issue', next: 'Phase' },
    ]);
  });

  it('omits on/next fields when not specified (not set to undefined)', () => {
    const doc = {
      Act: {
        executor: 'run',
        results: { done: { outcome: 'Finished' } },
      },
      states: { Finished: 'done' },
    };
    const { graph } = compileGraph(doc);
    const outcome = graph.Act.results.done.outcomes;
    assert.deepStrictEqual(Object.keys(outcome), ['name']);
    assert.strictEqual(outcome.name, 'Finished');
  });

  it('extracts states key into separate states map', () => {
    const doc = {
      Act: {
        executor: 'run',
        results: { done: { outcome: 'OK' } },
      },
      states: { OK: 'done', Started: 'todo' },
    };
    const { graph, states } = compileGraph(doc);
    assert.strictEqual(graph.states, undefined);
    assert.deepStrictEqual(states, { OK: 'done', Started: 'todo' });
  });

  it('uses label field when provided', () => {
    const doc = {
      'My Act': {
        label: 'Custom Label',
        executor: 'run',
        results: { done: { outcome: 'OK' } },
      },
      states: { OK: 'done' },
    };
    const { graph } = compileGraph(doc);
    assert.strictEqual(graph['My Act'].label, 'Custom Label');
  });

  it('defaults label to key name when not provided', () => {
    const doc = {
      'Some Act': {
        executor: 'run',
        results: { done: { outcome: 'OK' } },
      },
      states: { OK: 'done' },
    };
    const { graph } = compileGraph(doc);
    assert.strictEqual(graph['Some Act'].label, 'Some Act');
  });

  it('throws on validation errors — missing outcome name', () => {
    const doc = {
      Act: {
        executor: 'run',
        results: { done: { outcome: '' } },
      },
      states: {},
    };
    // empty string outcome produces a validation error (name is falsy)
    assert.throws(() => compileGraph(doc), /Graph validation failed/);
  });

  it('throws on validation errors — invalid on reference', () => {
    const doc = {
      Act: {
        executor: 'run',
        results: { done: { outcome: 'OK', on: 'NonExistent' } },
      },
      states: { OK: 'done' },
    };
    assert.throws(() => compileGraph(doc), /Graph validation failed/);
  });

  it('throws on validation errors — outcome not in states', () => {
    const doc = {
      Act: {
        executor: 'run',
        results: { done: { outcome: 'MissingState' } },
      },
      states: {},
    };
    assert.throws(() => compileGraph(doc), /Graph validation failed/);
  });
});

describe('loadGraph round-trip', () => {
  it('issue.yaml compiles to the same GRAPH and STATES as machine.js', () => {
    // loadGraph is already called by machine.js, so ORIGINAL_GRAPH/ORIGINAL_STATES
    // are the compiled result. Load fresh to double-check.
    const { graph, states } = loadGraph(join(__dirname, '../../graphs/issue.yaml'));
    assert.deepStrictEqual(graph, ORIGINAL_GRAPH);
    assert.deepStrictEqual(states, ORIGINAL_STATES);
  });
});
