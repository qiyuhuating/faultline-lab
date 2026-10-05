import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Queue } from '../src/queue.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-cache-'));
  const path = join(directory, 'queue.sqlite');
  let now = 1700000000000;
  const options = { clock: () => now };
  const queue = new Queue(path, options);
  const other = new Queue(path, options);
  queue.registerWorker('cache-worker', 1, 1);
  t.after(() => {
    other.close();
    queue.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { queue, other, advance: (ms) => (now += ms) };
}

function experiment(queue, key) {
  const { experimentId } = queue.experiment('duplicate', key);
  const claim = queue.claim('cache-worker');
  return { experimentId, claim };
}

test('another connection pruning invalidates a cached experiment in the same clock bucket', (t) => {
  const { queue, other, advance } = fixture(t);
  const { experimentId, claim } = experiment(queue, 'cache-pruning-intent');
  queue.complete(claim.id, 'cache-worker', claim.token, {});
  advance(31 * 86400000);
  assert.equal(queue.experimentReport(experimentId).verdict.status, 'pass');
  assert.equal(other.prune().removedJobs, 1);
  assert.throws(
    () => queue.experimentReport(experimentId),
    (error) => error.code === 'NOT_FOUND',
  );
});

for (const writer of ['same', 'other']) {
  test(`${writer} connection lease renewal invalidates a cached experiment without a new event`, (t) => {
    const { queue, other, advance } = fixture(t);
    const { experimentId, claim } = experiment(queue, `cache-${writer}-renewal`);
    const before = queue.experimentReport(experimentId);
    const sequence = queue.metadata('event_seq');
    advance(100);
    assert.equal(
      (writer === 'same' ? queue : other).renew(claim.id, 'cache-worker', claim.token),
      true,
    );
    assert.equal(queue.metadata('event_seq'), sequence);
    const after = queue.experimentReport(experimentId);
    assert.equal(after.jobs[0].leaseUntil, before.jobs[0].leaseUntil + 100);
  });
}

test('another connection deleting a receipt cannot reuse a cached passing verdict', (t) => {
  const { queue, other } = fixture(t);
  const { experimentId, claim } = experiment(queue, 'cache-receipt-intent');
  queue.complete(claim.id, 'cache-worker', claim.token, {});
  assert.equal(queue.experimentReport(experimentId).verdict.status, 'pass');
  const sequence = queue.metadata('event_seq');
  other.db.prepare('DELETE FROM receipts WHERE job_id=?').run(claim.id);
  assert.equal(queue.metadata('event_seq'), sequence);
  const after = queue.experimentReport(experimentId);
  assert.equal(after.jobs[0].receipts.length, 0);
  assert.equal(after.verdict.status, 'fail');
});

test('a report computed after a temporary deletion cannot survive transaction rollback', (t) => {
  const { queue } = fixture(t);
  const { experimentId, claim } = experiment(queue, 'cache-delete-rollback');
  queue.complete(claim.id, 'cache-worker', claim.token, {});
  assert.equal(queue.experimentReport(experimentId).verdict.status, 'pass');
  assert.throws(() => {
    queue.transaction(() => {
      queue.db.prepare('DELETE FROM receipts WHERE job_id=?').run(claim.id);
      assert.equal(queue.experimentReport(experimentId).verdict.status, 'fail');
      throw new Error('abort temporary deletion');
    });
  }, /abort temporary deletion/);
  assert.equal(queue.detail(claim.id).receipts.length, 1);
  assert.equal(queue.experimentReport(experimentId).verdict.status, 'pass');
});

test('a report computed after a temporary repair cannot survive transaction rollback', (t) => {
  const { queue } = fixture(t);
  const { experimentId, claim } = experiment(queue, 'cache-repair-rollback');
  queue.complete(claim.id, 'cache-worker', claim.token, {});
  const receipt = queue.db.prepare('SELECT * FROM receipts WHERE job_id=?').get(claim.id);
  queue.db.prepare('DELETE FROM receipts WHERE job_id=?').run(claim.id);
  assert.equal(queue.experimentReport(experimentId).verdict.status, 'fail');
  assert.throws(() => {
    queue.transaction(() => {
      queue.db
        .prepare('INSERT INTO receipts VALUES (?, ?, ?, ?, ?)')
        .run(
          receipt.job_id,
          receipt.generation,
          receipt.token,
          receipt.result,
          receipt.committed_at,
        );
      assert.equal(queue.experimentReport(experimentId).verdict.status, 'pass');
      throw new Error('abort temporary repair');
    });
  }, /abort temporary repair/);
  assert.equal(queue.detail(claim.id).receipts.length, 0);
  assert.equal(queue.experimentReport(experimentId).verdict.status, 'fail');
});
