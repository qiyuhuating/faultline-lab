import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Queue } from '../../src/queue.mjs';
import { Oracle } from './oracle.mjs';

export const COMMANDS = [
  'claim',
  'renew',
  'complete',
  'fail',
  'advance',
  'recover',
  'cancel',
  'replay',
  'pause',
  'deduplicate',
  'conflict',
  'reopen',
  'stop-worker',
  'restart-worker',
  'replay-intent',
  'new-intent',
];
function random(seed) {
  let value = seed >>> 0;
  return (max) => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return (value >>> 0) % max;
  };
}
function call(fn, expected) {
  if (expected.error) {
    assert.throws(fn, (error) => error.code === expected.error, `expected ${expected.error}`);
    return null;
  }
  const result = fn();
  assert.deepEqual(result, expected.value);
  return result;
}
function compare(queue, model) {
  for (const expected of model.jobs) {
    const job = queue.detail(expected.id);
    for (const key of [
      'state',
      'attempt',
      'generation',
      'revision',
      'token',
      'owner',
      'leaseUntil',
      'completedAt',
      'result',
    ])
      assert.deepEqual(job[key], expected[key], `${expected.priority}.${key}`);
    assert.deepEqual(
      job.attempts.map((a) => ({
        generation: a.generation,
        number: a.number,
        worker: a.worker_id,
        token: a.token,
        state: a.state,
        startedAt: a.started_at,
        endedAt: a.ended_at,
      })),
      expected.attempts,
    );
    assert.deepEqual(
      job.receipts.map((r) => ({ ...r })),
      expected.receipts,
    );
  }
  assert.equal(queue.metadata('paused'), String(model.paused));
  assert.equal(queue.db.isTransaction, false);
}
export function runModel({
  seed = 1,
  steps = 128,
  factory = (path, options) => new Queue(path, options),
} = {}) {
  assert.ok(Number.isSafeInteger(seed) && seed > 0 && seed <= 0xffffffff);
  assert.ok(Number.isSafeInteger(steps) && steps >= 1 && steps <= 10000);
  const directory = mkdtempSync(join(tmpdir(), 'faultline-model-'));
  const path = join(directory, 'queue.sqlite');
  const model = new Oracle(400),
    rng = random(seed);
  const make = () => factory(path, { clock: () => model.now, leaseMs: 400 });
  const queues = [make(), make()];
  const workers = ['model-a', 'model-b', 'model-c'];
  const definitions = [],
    submissionKeys = [],
    slotJobs = [],
    claims = [],
    intents = [],
    trace = [];
  const coverage = Object.fromEntries(COMMANDS.map((name) => [name, 0]));
  const started = performance.now();
  let step = -1;
  try {
    for (let i = 0; i < workers.length; i++) queues[0].registerWorker(workers[i], i + 1, i + 1);
    for (let i = 0; i < 5; i++) {
      const definition = {
        label: `model-${i}`,
        priority: i,
        maxAttempts: 3,
        delayMs: 0,
        text: 'model',
      };
      definitions.push(definition);
      submissionKeys.push(`model-${seed}-submit-${i}`);
      slotJobs.push(model.add(queues[0].submit(definition, submissionKeys[i]).jobId, i));
    }
    for (step = 0; step < steps; step++) {
      const name = COMMANDS[rng(COMMANDS.length)],
        index = rng(5),
        worker = workers[rng(3)],
        connection = rng(2),
        q = queues[connection];
      const captured = claims.length
        ? claims[rng(claims.length)]
        : { id: slotJobs[index].id, token: 0, worker };
      const claim = { ...captured };
      if (rng(4) === 0) claim.token++;
      const command = {
        step,
        name,
        index,
        worker,
        connection,
        claim: {
          slot: model.jobs.findIndex((j) => j.id === claim.id),
          token: claim.token,
          worker: claim.worker,
        },
        now: model.now,
      };
      trace.push(command);
      coverage[name]++;
      const key = `model-${seed}-step-${step}`;
      switch (name) {
        case 'claim': {
          const expected = model.claim(worker);
          if (expected.error) call(() => q.claim(worker), expected);
          else {
            const got = q.claim(worker);
            assert.equal(got?.id ?? null, expected.value?.id ?? null);
            if (got) {
              assert.equal(got.token, expected.value.token);
              claims.push(expected.value);
            }
          }
          break;
        }
        case 'renew':
          assert.equal(q.renew(claim.id, claim.worker, claim.token), model.renew(claim));
          break;
        case 'complete':
          assert.deepEqual(
            q.complete(claim.id, claim.worker, claim.token, { model: true }),
            model.complete(claim),
          );
          break;
        case 'fail':
          assert.deepEqual(
            q.fail(claim.id, claim.worker, claim.token, {
              code: 'MODEL_FAILURE',
              message: 'generated failure',
            }),
            model.fail(claim),
          );
          break;
        case 'advance':
          model.advance();
          break;
        case 'recover':
          assert.equal(q.recover(), model.expire());
          break;
        case 'cancel':
        case 'replay': {
          const revision = slotJobs[index].revision + (rng(3) === 0 ? 1 : 0);
          command.expectedRevision = revision;
          const expected = model.transition(slotJobs[index].id, name, revision);
          const invoke = () =>
            q.transition(slotJobs[index].id, name, revision, key, {
              clearFaults: name === 'replay',
            });
          const result = call(invoke, expected);
          if (result)
            intents.push({
              id: slotJobs[index].id,
              logicalId: model.jobs.indexOf(slotJobs[index]),
              action: name,
              revision,
              key,
              result,
            });
          break;
        }
        case 'pause':
          model.paused = Boolean(rng(2));
          command.paused = model.paused;
          assert.equal(q.setPaused(model.paused, key).paused, model.paused);
          break;
        case 'deduplicate': {
          const result = q.submit(definitions[index], submissionKeys[index]);
          assert.equal(result.jobId, slotJobs[index].id);
          assert.equal(result.deduplicated, true);
          break;
        }
        case 'conflict':
          assert.throws(
            () => q.submit({ ...definitions[index], text: 'different' }, submissionKeys[index]),
            (e) => e.code === 'IDEMPOTENCY_CONFLICT',
          );
          break;
        case 'reopen':
          q.close();
          queues[connection] = make();
          break;
        case 'stop-worker':
          q.stopWorker(worker, 'generated crash');
          model.stopped.add(worker);
          break;
        case 'restart-worker': {
          const slot = workers.indexOf(worker);
          q.stopWorker(worker, 'generated replacement');
          model.stopped.add(worker);
          const replacement = `model-${slot}-${step}`;
          q.registerWorker(replacement, slot + 1, step + 10);
          workers[slot] = replacement;
          command.replacement = replacement;
          break;
        }
        case 'new-intent':
          if (['succeeded', 'dead', 'cancelled'].includes(slotJobs[index].state)) {
            const definition = { ...definitions[index], label: `model-${index}-intent-${step}` };
            definitions[index] = definition;
            submissionKeys[index] = key;
            slotJobs[index] = model.add(q.submit(definition, key).jobId, index);
            command.logicalId = model.jobs.indexOf(slotJobs[index]);
          }
          break;
        case 'replay-intent':
          if (intents.length) {
            const intent = intents[rng(intents.length)];
            command.intent = {
              logicalId: intent.logicalId,
              action: intent.action,
              revision: intent.revision,
              key: intent.key,
            };
            assert.deepEqual(
              q.transition(intent.id, intent.action, intent.revision, intent.key, {
                clearFaults: intent.action === 'replay',
              }),
              { ...intent.result, deduplicated: true },
            );
          }
          break;
      }
      compare(queues[step % 2], model);
    }
    assert.equal(queues[0].evidence().integrity.valid, true);
    return {
      seed,
      steps,
      durationMs: Math.round(performance.now() - started),
      coverage,
      reopens: coverage.reopen,
      connections: 2,
      jobs: model.jobs.length,
      traceHash: createHash('sha256').update(JSON.stringify(trace)).digest('hex'),
      status: 'pass',
    };
  } catch (error) {
    error.reproduction = {
      format: 'faultline-model-failure-v1',
      seed,
      steps,
      failedStep: step,
      command: trace.at(-1),
      trace,
      coverage,
      message: error.message,
      reproduce: `node tests/model-runner.mjs --seed=${seed} --seeds=1 --steps=${step + 1}`,
    };
    throw error;
  } finally {
    for (const q of queues) q.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
