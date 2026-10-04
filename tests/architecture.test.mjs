import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue } from '../src/queue.mjs';
import { canonical, jobDefinition } from '../src/validation.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-architecture-'));
  const database = join(directory, 'queue.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return database;
}
test('v1.0.1 database reopens with unchanged durable request, receipt and fencing token', t => {
  const database = fixture(t);
  const legacy = new DatabaseSync(database);
  legacy.exec(readFileSync(new URL('./fixtures-v1.0.1-schema.sql', import.meta.url), 'utf8'));
  const definition = jobDefinition({ label: 'legacy', text: 'original input' });
  const encoded = canonical(definition);
  legacy.prepare(`INSERT INTO jobs (id,kind,label,definition,state,priority,max_attempts,attempt,generation,revision,lease_token,run_at,created_at,updated_at,completed_at,result)
    VALUES ('legacy-job','digest','legacy',?,'succeeded',0,4,1,0,3,7,100,100,200,200,?)`).run(encoded, '{"ok":true}');
  legacy.prepare('INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?,?)').run('legacy-job',0,1,'legacy-owner',7,'succeeded',100,200,null);
  legacy.prepare('INSERT INTO receipts VALUES (?,?,?,?,?)').run('legacy-job',0,7,'{"ok":true}',200);
  legacy.prepare('INSERT INTO requests VALUES (?,?,?,?)').run('legacy-intent', 'original-fingerprint', '{"jobId":"legacy-job"}',100);
  legacy.close();
  const queue = new Queue(database);
  try {
    const detail = queue.detail('legacy-job');
    assert.equal(detail.state, 'succeeded');
    assert.equal(detail.token, 7);
    assert.deepEqual(detail.result, { ok: true });
    assert.equal(detail.receipts.length, 1);
    assert.equal(detail.attempts[0].worker_id, 'legacy-owner');
    assert.equal(queue.requestStatus('legacy-intent').result.jobId, 'legacy-job');
    assert.equal(queue.db.prepare('SELECT fingerprint FROM requests WHERE key=?').get('legacy-intent').fingerprint, 'original-fingerprint');
    assert.deepEqual(queue.complete('legacy-job','legacy-owner',7,{ changed: true }), { accepted: false, reason: 'STALE_LEASE' });
    assert.equal(queue.metadata('schema_version'), '1');
  } finally { queue.close(); }
});
test('audit failure after repository completion rolls back receipt, state and attempt together', t => {
  const queue = new Queue(fixture(t));
  try {
    queue.registerWorker('worker-a',1,1);
    const id = queue.submit({}, 'audit-rollback-key').jobId;
    const job = queue.claim('worker-a');
    const head = queue.evidence().integrity.head;
    queue.db.exec(`CREATE TRIGGER reject_success_event BEFORE INSERT ON events WHEN NEW.type='job.succeeded' BEGIN SELECT RAISE(ABORT,'injected ledger failure'); END;`);
    assert.throws(() => queue.complete(id,'worker-a',job.token,{ ok: true }), /injected ledger failure/);
    const unchanged = queue.detail(id);
    assert.equal(unchanged.state, 'running');
    assert.equal(unchanged.receipts.length, 0);
    assert.equal(unchanged.attempts[0].state, 'running');
    assert.equal(unchanged.revision, job.revision);
    assert.equal(queue.evidence().integrity.head, head);
    queue.db.exec('DROP TRIGGER reject_success_event');
    assert.equal(queue.complete(id,'worker-a',job.token,{ ok: true }).accepted, true);
  } finally { queue.close(); }
});
test('experiment ledger failure rolls back nested idempotency, jobs and experiment record', t => {
  const queue = new Queue(fixture(t));
  try {
    queue.db.exec(`CREATE TRIGGER reject_experiment_event BEFORE INSERT ON events WHEN NEW.type='experiment.started' BEGIN SELECT RAISE(ABORT,'injected experiment failure'); END;`);
    assert.throws(() => queue.experiment('duplicate','experiment-rollback-key'), /injected experiment failure/);
    assert.equal(queue.snapshot().jobs.length, 0);
    assert.equal(queue.experiments().length, 0);
    assert.equal(queue.requestStatus('experiment-rollback-key').found, false);
    assert.equal(queue.db.prepare('SELECT COUNT(*) n FROM requests').get().n, 0);
    assert.equal(queue.evidence().integrity.count, 0);
    queue.db.exec('DROP TRIGGER reject_experiment_event');
    const retry = queue.experiment('duplicate','experiment-rollback-key');
    assert.equal(retry.deduplicated, false);
    assert.equal(retry.jobIds.length, 1);
    assert.equal(queue.snapshot().jobs.length, 1);
    assert.equal(queue.evidence().integrity.valid, true);
  } finally { queue.close(); }
});
test('inconsistent persisted lease is rejected by both detail and snapshot without rewriting it', t => {
  const queue = new Queue(fixture(t));
  try {
    queue.registerWorker('worker-a',1,1);
    const id = queue.submit({}, 'invalid-row-key').jobId;
    queue.claim('worker-a');
    queue.db.prepare('UPDATE jobs SET lease_owner=NULL WHERE id=?').run(id);
    const before = queue.raw(id);
    assert.throws(() => queue.detail(id), error => error.code === 'STORAGE_INVALID');
    assert.throws(() => queue.snapshot(), error => error.code === 'STORAGE_INVALID');
    assert.deepEqual(queue.raw(id), before);
    assert.equal(queue.db.isTransaction, false);
  } finally { queue.close(); }
});
