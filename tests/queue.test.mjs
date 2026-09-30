import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue } from '../src/queue.mjs';
import { execute } from '../src/handlers.mjs';

function fixture(t) {
  let now = 1700000000000;
  const directory = mkdtempSync(join(tmpdir(), 'faultline-unit-'));
  const database = join(directory, 'queue.sqlite');
  const queue = new Queue(database, { clock: () => now });
  queue.registerWorker('worker-a', 1, 11);
  queue.registerWorker('worker-b', 2, 12);
  t.after(() => { queue.close(); rmSync(directory, { recursive: true, force: true }); });
  return { queue, database, advance: ms => { now += ms; }, now: () => now };
}
const submit = (q, options = {}, key = 'request-0001') => q.submit({ label: 'test', text: 'hello', delayMs: 0, ...options }, key).jobId;
const code = expected => error => error.code === expected;

test('same intent creates one durable task across two connections', t => {
  const { queue, database } = fixture(t);
  const id = submit(queue);
  const other = new Queue(database);
  try {
    const repeated = other.submit({ label: 'test', text: 'hello', delayMs: 0 }, 'request-0001');
    assert.equal(repeated.jobId, id);
    assert.equal(repeated.deduplicated, true);
    assert.equal(queue.snapshot().counts.queued, 1);
  } finally { other.close(); }
});

test('same idempotency key with different content is a conflict', t => {
  const { queue } = fixture(t);
  submit(queue);
  assert.throws(() => submit(queue, { text: 'changed' }), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(queue.snapshot().counts.queued, 1);
});

test('canonical defaults and property order identify the same request', t => {
  const { queue } = fixture(t);
  const first = queue.submit({ label: 'alpha', text: 'x' }, 'canonical-key');
  const second = queue.submit({ text: 'x', label: 'alpha', maxAttempts: 4, priority: 0 }, 'canonical-key');
  assert.equal(first.jobId, second.jobId);
});

test('invalid data does not overwrite or append a job', t => {
  const { queue } = fixture(t);
  const before = queue.evidence().integrity.head;
  for (const bad of [{ unknown: true }, { maxAttempts: 99 }, { text: '字'.repeat(5000) }, { label: '' }, { fault: { crashOnce: 'yes' } }]) {
    assert.throws(() => queue.submit(bad, 'invalid-key'), code('VALIDATION'));
  }
  assert.equal(queue.evidence().integrity.head, before);
  assert.equal(queue.snapshot().jobs.length, 0);
});

test('priority applies only to due jobs; delayed tasks cannot be claimed early', t => {
  const { queue, advance } = fixture(t);
  const low = submit(queue, { priority: 0 }, 'priority-low');
  const high = submit(queue, { priority: 5 }, 'priority-high');
  const delayed = submit(queue, { priority: 5, scheduleMs: 6000 }, 'priority-delay');
  assert.equal(queue.claim('worker-a').id, high);
  assert.equal(queue.claim('worker-b').id, low);
  assert.equal(queue.claim('worker-a'), null);
  advance(6100);
  assert.equal(queue.claim('worker-a').id, delayed);
});

test('two connections cannot claim the same live lease', t => {
  const { queue, database, now } = fixture(t);
  submit(queue);
  const other = new Queue(database, { clock: now });
  try {
    assert.ok(queue.claim('worker-a'));
    assert.equal(other.claim('worker-b'), null);
  } finally { other.close(); }
});

test('wrong owner and token cannot renew or commit', t => {
  const { queue } = fixture(t);
  const id = submit(queue);
  const claim = queue.claim('worker-a');
  assert.equal(queue.renew(id, 'worker-b', claim.token), false);
  assert.equal(queue.renew(id, 'worker-a', claim.token + 1), false);
  assert.equal(queue.complete(id, 'worker-b', claim.token, {}).accepted, false);
  assert.equal(queue.complete(id, 'worker-a', claim.token + 1, {}).accepted, false);
  assert.equal(queue.detail(id).receipts.length, 0);
});

test('lease expiry is recovered and a stale worker cannot overwrite a new owner', t => {
  const { queue, advance } = fixture(t);
  const id = submit(queue);
  const old = queue.claim('worker-a');
  advance(2401);
  assert.equal(queue.recover(), 1);
  advance(1000);
  const current = queue.claim('worker-b');
  assert.equal(current.token, old.token + 1);
  assert.equal(queue.complete(id, 'worker-a', old.token, { stale: true }).accepted, false);
  assert.equal(queue.complete(id, 'worker-b', current.token, { current: true }).accepted, true);
  assert.deepEqual(queue.detail(id).result, { current: true });
  assert.equal(queue.detail(id).receipts.length, 1);
  assert.deepEqual(queue.detail(id).attempts.map(a => a.state), ['expired', 'succeeded']);
});

test('expired lease cannot be renewed or committed before a sweeper runs', t => {
  const { queue, advance } = fixture(t);
  const id = submit(queue);
  const claim = queue.claim('worker-a');
  advance(2400);
  assert.equal(queue.renew(id, 'worker-a', claim.token), false);
  assert.equal(queue.complete(id, 'worker-a', claim.token, {}).accepted, false);
});

test('heartbeat extends an active lease', t => {
  const { queue, advance } = fixture(t);
  const id = submit(queue);
  const claim = queue.claim('worker-a');
  advance(1500);
  assert.equal(queue.renew(id, 'worker-a', claim.token), true);
  advance(1200);
  assert.equal(queue.recover(), 0);
  assert.equal(queue.complete(id, 'worker-a', claim.token, { ok: true }).accepted, true);
});

test('retry budget, exponential delay and jitter are enforced', t => {
  const { queue, advance, now } = fixture(t);
  const id = submit(queue, { maxAttempts: 3 });
  for (let attempt = 1; attempt <= 3; attempt++) {
    const claim = queue.claim('worker-a');
    assert.equal(claim.attempt, attempt);
    const failure = queue.fail(id, 'worker-a', claim.token, { code: 'TEST_FAILURE', message: 'bad' });
    assert.equal(failure.state, attempt === 3 ? 'dead' : 'retry_wait');
    if (attempt < 3) {
      const delay = queue.detail(id).runAt - now();
      assert.ok(delay >= 500 * 2 ** (attempt - 1) * 0.8 && delay <= 500 * 2 ** (attempt - 1) * 1.2);
      assert.equal(queue.claim('worker-a'), null);
      advance(delay);
    }
  }
  assert.equal(queue.detail(id).state, 'dead');
  assert.equal(queue.claim('worker-a'), null);
});

test('revision conflict rejects a stale action without changing the job', t => {
  const { queue } = fixture(t);
  const id = submit(queue);
  queue.claim('worker-a');
  assert.throws(() => queue.transition(id, 'cancel', 1, 'stale-action'), code('REVISION_CONFLICT'));
  assert.equal(queue.detail(id).state, 'running');
});

test('cancel fences in-flight work; repeated cancel is idempotent', t => {
  const { queue } = fixture(t);
  const id = submit(queue);
  const claim = queue.claim('worker-a');
  const result = queue.transition(id, 'cancel', claim.revision, 'cancel-intent');
  assert.equal(queue.complete(id, 'worker-a', claim.token, {}).accepted, false);
  assert.equal(queue.detail(id).attempts[0].state, 'cancelled');
  const again = queue.transition(id, 'cancel', claim.revision, 'cancel-intent');
  assert.equal(again.deduplicated, true);
  assert.equal(again.revision, result.revision);
});

test('dead-letter replay retains history and advances the generation', t => {
  const { queue } = fixture(t);
  const id = submit(queue, { maxAttempts: 1, fault: { failFirst: 5 } });
  const first = queue.claim('worker-a');
  queue.fail(id, 'worker-a', first.token, { code: 'FAIL', message: 'fail' });
  const dead = queue.detail(id);
  queue.transition(id, 'replay', dead.revision, 'replay-intent', { clearFaults: true });
  const replay = queue.claim('worker-b');
  assert.equal(replay.generation, 1);
  assert.equal(replay.definition.fault.failFirst, 0);
  assert.equal(queue.complete(id, 'worker-a', first.token, {}).accepted, false);
  queue.complete(id, 'worker-b', replay.token, { recovered: true });
  assert.deepEqual(queue.detail(id).attempts.map(a => a.generation), [0, 1]);
  assert.equal(queue.detail(id).receipts[0].generation, 1);
});

test('successful task cannot be replayed into duplicate side effects', t => {
  const { queue } = fixture(t);
  const id = submit(queue);
  const claim = queue.claim('worker-a');
  queue.complete(id, 'worker-a', claim.token, {});
  assert.throws(() => queue.transition(id, 'replay', queue.detail(id).revision, 'replay-success'), code('INVALID_TRANSITION'));
});

test('pause prevents new claims but permits in-flight commits', t => {
  const { queue } = fixture(t);
  const id = submit(queue);
  const claim = queue.claim('worker-a');
  submit(queue, {}, 'another-job');
  queue.setPaused(true, 'pause-intent');
  assert.equal(queue.claim('worker-b'), null);
  assert.equal(queue.complete(id, 'worker-a', claim.token, {}).accepted, true);
  queue.setPaused(false, 'resume-intent');
  assert.ok(queue.claim('worker-b'));
});

test('duplicate experiment invokes actual deduplication and yields one job', t => {
  const { queue } = fixture(t);
  const result = queue.experiment('duplicate', 'x'.repeat(128));
  assert.equal(result.submissions, 3);
  assert.equal(result.jobIds.length, 1);
  assert.equal(queue.snapshot().metrics.deduplicated, 2);
});

test('receipt and success commit atomically, and duplicate completion is rejected', t => {
  const { queue } = fixture(t);
  const id = submit(queue);
  const claim = queue.claim('worker-a');
  queue.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'injected disk boundary'); END");
  assert.throws(() => queue.complete(id, 'worker-a', claim.token, { ok: true }));
  assert.equal(queue.detail(id).state, 'running');
  assert.equal(queue.detail(id).receipts.length, 0);
  queue.db.exec('DROP TRIGGER reject_receipt');
  assert.equal(queue.complete(id, 'worker-a', claim.token, { ok: true }).accepted, true);
  assert.equal(queue.complete(id, 'worker-a', claim.token, { wrong: true }).accepted, false);
  assert.deepEqual(queue.detail(id).result, { ok: true });
});

test('event chain detects modified payloads', t => {
  const { queue } = fixture(t);
  submit(queue);
  assert.equal(queue.evidence().integrity.valid, true);
  queue.db.prepare("UPDATE events SET data='{}' WHERE type='job.created'").run();
  assert.equal(queue.evidence().integrity.valid, false);
});

test('retention preserves live jobs and advances the chain anchor', t => {
  const { queue, advance } = fixture(t);
  const finished = submit(queue, {}, 'old-finished');
  const claim = queue.claim('worker-a');
  queue.complete(finished, 'worker-a', claim.token, {});
  const active = submit(queue, { scheduleMs: 60000 }, 'old-live-job');
  advance(31 * 86400000);
  const result = queue.prune();
  assert.equal(result.removedJobs, 1);
  assert.equal(queue.detail(active).state, 'queued');
  assert.throws(() => queue.detail(finished), code('NOT_FOUND'));
  submit(queue, {}, 'after-retain');
  assert.equal(queue.evidence().integrity.valid, true);
  assert.notEqual(queue.evidence().integrity.anchor, 'GENESIS');
});

test('keyset pagination returns disjoint pages and supports state filters', t => {
  const { queue } = fixture(t);
  for (let i = 0; i < 45; i++) submit(queue, { label: `task ${i}` }, `pagination-${i}`);
  const first = queue.snapshot();
  assert.equal(first.jobs.length, 40);
  const next = queue.snapshot({ before: first.nextBefore });
  assert.equal(next.jobs.length, 5);
  assert.equal(new Set([...first.jobs, ...next.jobs].map(j => j.id)).size, 45);
  assert.equal(queue.snapshot({ state: 'dead' }).jobs.length, 0);
});

test('SQL-looking labels remain data', t => {
  const { queue } = fixture(t);
  const label = "x'); DROP TABLE jobs; --";
  const id = submit(queue, { label });
  assert.equal(queue.detail(id).label, label);
  assert.equal(queue.snapshot().counts.queued, 1);
});

test('handlers return real summaries and reject invalid numeric input', () => {
  assert.equal(execute('digest', 'hello').sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.deepEqual(execute('csv_summary', '2,4,6').mean, 4);
  assert.throws(() => execute('csv_summary', '2,NaN,6'), code('INPUT_INVALID'));
  assert.throws(() => execute('csv_summary', 'Infinity'), code('INPUT_INVALID'));
});
