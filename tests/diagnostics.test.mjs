import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue } from '../src/queue.mjs';
import { digest } from '../src/validation.mjs';
import { verifyEvidence } from '../public/evidence.mjs';
import { diagnose } from '../tools/doctor.mjs';
import { startServer } from '../src/server.mjs';

function databaseState(db) {
  return JSON.stringify(
    Object.fromEntries(
      [
        'meta',
        'jobs',
        'attempts',
        'receipts',
        'requests',
        'workers',
        'events',
        'experiments',
        'sqlite_sequence',
      ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    ),
  );
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-doctor-'));
  const path = join(directory, 'queue.sqlite');
  let now = 1700000000000;
  const queue = new Queue(path, { clock: () => now });
  t.after(() => {
    queue.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { queue, path, clock: () => now, advance: (ms) => (now += ms) };
}
function succeed(queue) {
  queue.registerWorker('worker-a', 1, 1);
  const id = queue.submit({}, 'diagnostic-key').jobId;
  const claim = queue.claim('worker-a');
  queue.complete(id, 'worker-a', claim.token, { ok: true });
  return id;
}
const status = (report, id) => report.checks.find((c) => c.id === id).status;
test('unreadable event JSON fails read-only diagnosis without exposing its parse input', (t) => {
  const { queue, path, clock } = fixture(t);
  queue.submit({ label: 'private label', text: 'private payload' }, 'private-event-intent');
  queue.db.prepare('UPDATE events SET data=? WHERE seq=1').run('HUSH_731');
  const before = databaseState(queue.db);
  for (const report of [queue.diagnostics(), diagnose(path, clock)]) {
    assert.equal(report.verdict, 'fail');
    assert.equal(status(report, 'event-chain'), 'fail');
    for (const secret of ['HUSH_731', 'private label', 'private payload'])
      assert.equal(JSON.stringify(report).includes(secret), false);
  }
  assert.deepEqual(databaseState(queue.db), before);
});
test('HTTP diagnostics do not return private malformed event content', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-doctor-private-http-'));
  const instance = await startServer({
    port: 0,
    database: join(directory, 'queue.sqlite'),
    workers: 0,
    quiet: true,
  });
  t.after(async () => {
    await instance.close();
    rmSync(directory, { recursive: true, force: true });
  });
  instance.queue.submit({}, 'http-private-event-intent');
  instance.queue.db.prepare('UPDATE events SET data=? WHERE seq=1').run('HUSH_732');
  const before = databaseState(instance.queue.db);
  const response = await fetch(`${instance.url}/api/diagnostics`);
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.verdict, 'fail');
  assert.equal(status(report, 'event-chain'), 'fail');
  assert.equal(JSON.stringify(report).includes('HUSH_732'), false);
  assert.deepEqual(databaseState(instance.queue.db), before);
});
for (const [field, value] of [
  ['kind', 'csv_summary'],
  ['label', 'changed private label'],
  ['priority', 99],
  ['max_attempts', 99],
]) {
  test(`doctor rejects stored job ${field} that disagrees with its definition`, (t) => {
    const { queue, path, clock } = fixture(t);
    const { jobId } = queue.submit(
      { label: 'original private label', text: 'private payload', priority: 0, maxAttempts: 4 },
      `definition-${field}-intent`,
    );
    queue.db.prepare(`UPDATE jobs SET ${field}=? WHERE id=?`).run(value, jobId);
    const before = databaseState(queue.db);
    const report = diagnose(path, clock);
    assert.equal(report.verdict, 'fail');
    assert.equal(status(report, 'json-records'), 'fail');
    assert.equal(status(report, 'event-chain'), 'pass');
    assert.deepEqual(databaseState(queue.db), before);
    for (const text of ['private payload', 'original private label', 'changed private label'])
      assert.equal(JSON.stringify(report).includes(text), false);
  });
}
for (const [field, value] of [
  ['definition', '{"priority":99}'],
  ['last_error', '{}'],
]) {
  test(`doctor rejects unreadable ${field} even when it is valid JSON`, (t) => {
    const { queue, path, clock } = fixture(t);
    const id = succeed(queue);
    queue.db.prepare(`UPDATE jobs SET ${field}=? WHERE id=?`).run(value, id);
    const before = databaseState(queue.db);
    const report = diagnose(path, clock);
    assert.equal(report.verdict, 'fail');
    assert.equal(status(report, 'json-records'), 'fail');
    assert.deepEqual(databaseState(queue.db), before);
    assert.equal(JSON.stringify(report).includes('priority'), false);
  });
}
test('doctor detects a missing failed attempt and an incorrect successful attempt counter', (t) => {
  const { queue, path, clock, advance } = fixture(t);
  queue.registerWorker('worker-a', 1, 1);
  const id = queue.submit({}, 'attempt-history-key').jobId;
  let claim = queue.claim('worker-a');
  queue.fail(id, 'worker-a', claim.token, {});
  advance(10000);
  claim = queue.claim('worker-a');
  queue.complete(id, 'worker-a', claim.token, {});
  assert.equal(diagnose(path, clock).verdict, 'pass');
  queue.db.prepare('DELETE FROM attempts WHERE job_id=? AND number=1').run(id);
  assert.equal(status(diagnose(path, clock), 'attempt-history'), 'fail');
  queue.db.prepare('UPDATE jobs SET attempt=1 WHERE id=?').run(id);
  assert.equal(status(diagnose(path, clock), 'attempt-history'), 'fail');
});
test('doctor detects attempt records from a future generation', (t) => {
  const { queue, path, clock } = fixture(t);
  succeed(queue);
  queue.db.exec('UPDATE attempts SET generation=1');
  assert.equal(status(diagnose(path, clock), 'attempt-history'), 'fail');
});
test('read-only doctor checks a healthy database without changing any logical record', (t) => {
  const { queue, path, clock } = fixture(t);
  succeed(queue);
  const before = databaseState(queue.db);
  const report = diagnose(path, clock);
  assert.equal(report.verdict, 'pass');
  assert.equal(report.counts.receipts, 1);
  assert.equal(status(report, 'event-chain'), 'pass');
  assert.deepEqual(databaseState(queue.db), before);
});
test('read-only doctor does not create a missing database or its parent directory', (t) => {
  const { path } = fixture(t);
  const missing = join(path + '-missing', 'absent.sqlite');
  assert.throws(() => diagnose(missing));
  assert.equal(existsSync(missing), false);
  assert.equal(existsSync(path + '-missing'), false);
});
test('read-only doctor leaves legacy schema metadata untouched', (t) => {
  const { queue, path, clock } = fixture(t);
  queue.db.exec("DELETE FROM meta WHERE key='event_anchor_seq'");
  queue.submit({}, 'legacy-diag-key');
  const before = databaseState(queue.db);
  assert.equal(diagnose(path, clock).verdict, 'pass');
  assert.deepEqual(databaseState(queue.db), before);
  assert.equal(queue.metadata('event_anchor_seq'), undefined);
});
test('missing successful receipt is detected even while event hashes remain valid', (t) => {
  const { queue, path, clock } = fixture(t);
  succeed(queue);
  queue.db.exec('DELETE FROM receipts');
  assert.equal(queue.evidence().integrity.valid, true);
  const report = diagnose(path, clock);
  assert.equal(report.verdict, 'fail');
  assert.equal(status(report, 'receipt-state'), 'fail');
  assert.equal(status(report, 'attempt-receipt'), 'fail');
});
test('a receipt from a losing token and a dangling running attempt fail distinct checks', (t) => {
  const { queue, path, clock } = fixture(t);
  succeed(queue);
  queue.db.exec("UPDATE receipts SET token=999; UPDATE attempts SET state='running',ended_at=NULL");
  const report = diagnose(path, clock);
  assert.equal(status(report, 'receipt-owner'), 'fail');
  assert.equal(status(report, 'running-attempt'), 'fail');
});
test('expired leases warn without recovering or consuming attempts', (t) => {
  const { queue, path, clock, advance } = fixture(t);
  queue.registerWorker('worker-a', 1, 1);
  const id = queue.submit({}, 'expired-diag-key').jobId;
  queue.claim('worker-a');
  advance(3001);
  const before = queue.raw(id);
  const report = diagnose(path, clock);
  assert.equal(report.verdict, 'warn');
  assert.equal(status(report, 'expired-leases'), 'warn');
  assert.deepEqual(queue.raw(id), before);
});
test('deleting every retained event cannot be mistaken for an empty valid ledger', async (t) => {
  const { queue, path, clock } = fixture(t);
  queue.submit({}, 'lost-ledger-key');
  queue.db.exec('DELETE FROM events');
  const evidence = queue.evidence();
  assert.equal(evidence.integrity.valid, false);
  await assert.rejects(() => verifyEvidence(evidence, digest));
  assert.equal(status(diagnose(path, clock), 'event-chain'), 'fail');
});
test('an exactly pruned empty chain stays valid and the next append keeps its boundary', async (t) => {
  const { queue, advance } = fixture(t);
  queue.submit({}, 'pruned-ledger-key');
  advance(31 * 86400000);
  queue.prune();
  const empty = queue.evidence();
  assert.equal(empty.events.length, 0);
  assert.equal(empty.integrity.valid, true);
  assert.equal(empty.integrity.range.anchorSequence, empty.integrity.range.headSequence);
  await verifyEvidence(empty, digest);
  queue.submit({}, 'after-prefix-key');
  assert.equal(queue.evidence().integrity.valid, true);
  await verifyEvidence(queue.evidence(), digest);
});
test('unknown legacy empty prefixes stay unverified instead of blessing lost tail data', async (t) => {
  const { queue, advance } = fixture(t);
  queue.submit({}, 'old-prefix-key');
  advance(31 * 86400000);
  queue.prune();
  queue.db.exec("DELETE FROM meta WHERE key='event_anchor_seq'");
  const evidence = queue.evidence();
  assert.equal(evidence.integrity.valid, false);
  assert.equal(evidence.integrity.range.source, 'unknown');
  await assert.rejects(() => verifyEvidence(evidence, digest));
});
test('portable evidence rejects forged range start and truncated tail even with matching counts', async (t) => {
  const { queue } = fixture(t);
  succeed(queue);
  const evidence = queue.evidence();
  for (const alter of [
    (e) => {
      e.integrity.range.anchorSequence++;
    },
    (e) => {
      e.events = [];
      e.integrity.count = 0;
      e.integrity.head = e.integrity.anchor;
    },
  ]) {
    const changed = structuredClone(evidence);
    alter(changed);
    await assert.rejects(() => verifyEvidence(changed, digest));
  }
});
test('malformed event JSON is diagnosed as failure rather than rewritten', (t) => {
  const { queue, path, clock } = fixture(t);
  queue.submit({}, 'bad-json-diag-key');
  queue.db.exec("UPDATE events SET data='{broken' WHERE seq=1");
  const before = databaseState(queue.db);
  assert.equal(status(diagnose(path, clock), 'event-chain'), 'fail');
  assert.deepEqual(databaseState(queue.db), before);
});
test('untyped callers cannot commit a result that violates the typed successful state', (t) => {
  const { queue } = fixture(t);
  queue.registerWorker('worker-a', 1, 1);
  const id = queue.submit({}, 'bad-result-key').jobId;
  const job = queue.claim('worker-a');
  for (const result of [null, [], { bad: undefined }])
    assert.throws(() => queue.complete(id, 'worker-a', job.token, result));
  assert.equal(queue.detail(id).state, 'running');
  assert.equal(queue.detail(id).receipts.length, 0);
});
test('HTTP diagnostics is observation only and exposes no inputs, control token or database path', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-doctor-http-'));
  const app = await startServer({
    port: 0,
    database: join(directory, 'queue.sqlite'),
    workers: 0,
    quiet: true,
  });
  try {
    app.queue.submit({ text: 'private task text' }, 'http-diag-key');
    const before = app.queue.evidence();
    const response = await fetch(app.url + '/api/diagnostics');
    assert.equal(response.status, 200);
    const text = await response.text();
    const report = JSON.parse(text);
    assert.equal(report.format, 'faultline-diagnostics-v1');
    assert.equal(report.verdict, 'pass');
    assert.ok(
      !text.includes('private task text') && !text.includes(app.token) && !text.includes(directory),
    );
    assert.equal(app.queue.evidence().integrity.head, before.integrity.head);
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('nonempty legacy retained prefixes remain readable and explicitly warn about inferred boundaries', async (t) => {
  const { queue, path, clock, advance } = fixture(t);
  queue.submit({}, 'legacy-prefix-one');
  advance(31 * 86400000);
  queue.prune();
  queue.db.exec("DELETE FROM meta WHERE key='event_anchor_seq'");
  queue.submit({}, 'legacy-prefix-two');
  const before = databaseState(queue.db);
  const evidence = queue.evidence();
  assert.equal(evidence.integrity.valid, true);
  assert.equal(evidence.integrity.range.source, 'legacy-inferred');
  await verifyEvidence(evidence, digest);
  assert.equal(status(diagnose(path, clock), 'event-chain'), 'warn');
  assert.equal(databaseState(queue.db), before);
});
