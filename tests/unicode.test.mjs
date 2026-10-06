import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Queue } from '../src/queue.mjs';
import { startServer } from '../src/server.mjs';
import { diagnose } from '../tools/doctor.mjs';

const malformed = ['\ud800', '\udc00', 'left\ud800right', 'left\udc00right', '\udc00\ud800', '\ud800\ud800'];
function state(db) {
  return JSON.stringify(Object.fromEntries(['meta', 'jobs', 'attempts', 'receipts', 'requests', 'workers', 'events', 'experiments', 'sqlite_sequence'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}

test('ill-formed Unicode task labels are rejected without changing any record or reserving their request key', t => {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-label-validation-'));
  const queue = new Queue(join(directory, 'queue.sqlite'));
  t.after(() => { queue.close(); rmSync(directory, { recursive: true, force: true }); });
  queue.submit({ label: 'existing task' }, 'existing-label-intent');
  const before = state(queue.db);
  for (const label of malformed) {
    assert.throws(() => queue.submit({ label }, 'invalid-label-intent'), error => error.code === 'VALIDATION');
    assert.equal(state(queue.db), before);
    assert.equal(queue.requestStatus('invalid-label-intent').found, false);
  }
  assert.equal(queue.diagnostics().verdict, 'pass');
});

test('HTTP rejects ill-formed labels before persistence and the same key can submit a valid Unicode label', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-label-http-'));
  const app = await startServer({ port: 0, database: join(directory, 'queue.sqlite'), workers: 0, quiet: true });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  app.queue.submit({ label: 'existing task' }, 'existing-http-label-intent');
  const before = state(app.queue.db);
  const headers = { 'Content-Type': 'application/json', 'X-Control-Token': app.token, 'Idempotency-Key': 'http-unicode-label-intent' };
  for (const label of malformed) {
    const response = await fetch(app.url + '/api/jobs', { method: 'POST', headers, body: JSON.stringify({ label }) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'VALIDATION');
    assert.equal(state(app.queue.db), before);
    const lookup = await (await fetch(app.url + '/api/requests/http-unicode-label-intent')).json();
    assert.equal(lookup.found, false);
  }
  const label = '作品 😀𠮷𝄞 🧪';
  const response = await fetch(app.url + '/api/jobs', { method: 'POST', headers, body: JSON.stringify({ label }) });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.deduplicated, false);
  const { job: detail } = await (await fetch(app.url + '/api/jobs/' + result.jobId)).json();
  assert.equal(detail.label, label);
  assert.equal(detail.definition.label, label);
  assert.equal(app.queue.diagnostics().verdict, 'pass');
  assert.equal(app.queue.evidence().integrity.valid, true);
});

test('well-formed Unicode labels survive normalization, request replay and database reopen', t => {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-label-roundtrip-'));
  const database = join(directory, 'queue.sqlite');
  let queue = new Queue(database);
  t.after(() => { queue.close(); rmSync(directory, { recursive: true, force: true }); });
  const cases = ['  作品 😀𠮷𝄞 🧪  ', '😀'.repeat(40), 'left\u0000right', '\ufffd', '任务 العربية'];
  const jobs = cases.map((label, index) => {
    const key = `unicode-roundtrip-${index}`;
    const first = queue.submit({ label }, key);
    const replay = queue.submit({ label: label.trim() }, key);
    assert.equal(replay.jobId, first.jobId);
    assert.equal(replay.deduplicated, true);
    return { id: first.jobId, label: label.trim() };
  });
  queue.close();
  queue = new Queue(database);
  for (const { id, label } of jobs) {
    const job = queue.detail(id);
    assert.equal(job.label, label);
    assert.equal(job.definition.label, label);
  }
  assert.equal(queue.evidence().integrity.valid, true);
  assert.equal(diagnose(database).verdict, 'pass');
});

test('an existing legacy ill-formed label remains readable and cannot block later healthy work', t => {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-label-legacy-'));
  const queue = new Queue(join(directory, 'queue.sqlite'));
  t.after(() => { queue.close(); rmSync(directory, { recursive: true, force: true }); });
  const legacy = queue.submit({ label: '\ufffd', delayMs: 0 }, 'legacy-label-intent').jobId;
  const definition = JSON.parse(queue.raw(legacy).definition);
  // Frozen v1.2.3 accepted this label: JSON kept the surrogate; SQLite saved U+FFFD.
  definition.label = '\ud800';
  queue.db.prepare('UPDATE jobs SET definition=? WHERE id=?').run(JSON.stringify(definition), legacy);
  const before = state(queue.db);
  assert.equal(queue.diagnostics().verdict, 'fail');
  assert.equal(queue.detail(legacy).definition.label, '\ud800');
  assert.equal(state(queue.db), before);
  const healthy = queue.submit({ label: 'healthy task', delayMs: 0 }, 'healthy-after-legacy-label').jobId;
  queue.registerWorker('worker-a', 1, 1);
  const first = queue.claim('worker-a');
  assert.equal(first.id, legacy);
  assert.equal(queue.complete(first.id, 'worker-a', first.token, { ok: true }).accepted, true);
  const second = queue.claim('worker-a');
  assert.equal(second.id, healthy);
  assert.equal(queue.complete(second.id, 'worker-a', second.token, { ok: true }).accepted, true);
  assert.equal(queue.detail(healthy).state, 'succeeded');
  assert.equal(queue.detail(legacy).definition.label, '\ud800');
  assert.equal(queue.diagnostics().verdict, 'fail');
  assert.equal(queue.evidence().integrity.valid, true);
});
