import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../src/queue.mjs';
import { runModel } from './model/runner.mjs';
test('independent state oracle checks 16 deterministic seeds across connections and restart', () => {
  for (let seed = 1; seed <= 16; seed++) assert.equal(runModel({ seed, steps: 96 }).status, 'pass');
});
test('the independent oracle detects a worker accepting every stale renewal', () => {
  assert.throws(
    () =>
      runModel({
        seed: 17,
        steps: 96,
        factory: (path, options) => {
          const q = new Queue(path, options);
          q.renew = () => true;
          return q;
        },
      }),
    (error) => error.reproduction?.seed === 17 && error.reproduction?.command.name === 'renew',
  );
});
test('the independent oracle detects successful responses fabricated for stale commits', () => {
  assert.throws(
    () =>
      runModel({
        seed: 19,
        steps: 96,
        factory: (path, options) => {
          const q = new Queue(path, options);
          q.complete = () => ({ accepted: true });
          return q;
        },
      }),
    (error) => error.reproduction?.command.name === 'complete',
  );
});

test('a seed reproduces the same logical transcript despite different UUIDs', () => {
  assert.equal(
    runModel({ seed: 41, steps: 160 }).traceHash,
    runModel({ seed: 41, steps: 160 }).traceHash,
  );
});
test('the independent oracle detects a service bypassing expectedRevision', () => {
  assert.throws(
    () =>
      runModel({
        seed: 43,
        steps: 128,
        factory: (path, options) => {
          const q = new Queue(path, options);
          const original = q.transition.bind(q);
          q.transition = (id, action, revision, key, options) =>
            original(id, action, q.detail(id).revision, key, options);
          return q;
        },
      }),
    (error) => ['cancel', 'replay', 'replay-intent'].includes(error.reproduction?.command.name),
  );
});
test('a failed campaign preserves a repeatable command prefix and reproduction command', () => {
  const factory = (path, options) => {
    const q = new Queue(path, options);
    q.renew = () => true;
    return q;
  };
  let first, second;
  try {
    runModel({ seed: 47, steps: 128, factory });
  } catch (error) {
    first = error.reproduction;
  }
  assert.ok(first);
  try {
    runModel({ seed: 47, steps: first.failedStep + 1, factory });
  } catch (error) {
    second = error.reproduction;
  }
  assert.deepEqual(first.trace, second.trace);
  assert.equal(first.failedStep, second.failedStep);
  assert.match(first.reproduce, /--seed=47 --seeds=1 --steps=/);
});
