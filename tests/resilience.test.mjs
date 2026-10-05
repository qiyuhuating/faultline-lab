import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer, request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { Queue } from '../src/queue.mjs';
import { startServer } from '../src/server.mjs';

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-resilience-'));
  const path = join(directory, 'queue.sqlite');
  const queue = new Queue(path, options);
  queue.registerWorker('test-worker', 1, 1);
  t.after(() => { queue.close(); rmSync(directory, { recursive: true, force: true }); });
  return { queue, path };
}
async function until(predicate, timeout = 12000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(20);
  }
  throw new Error('Real process did not reach the expected state.');
}
function message(child, type) {
  return new Promise((resolve, reject) => {
    const receive = value => { if (value.type === type) { cleanup(); resolve(value); } };
    const gone = () => { cleanup(); reject(new Error('Lock holder exited before handshake.')); };
    const cleanup = () => { child.off('message', receive); child.off('exit', gone); };
    child.on('message', receive); child.on('exit', gone);
  });
}
async function appFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-service-'));
  const database = join(directory, 'queue.sqlite');
  const app = await startServer({ port: 0, database, workers: 0, quiet: true });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { app, database };
}

test('a real SQLite writer lock cannot renew a lease that expires while waiting', { timeout: 8000 }, async t => {
  const { queue, path } = fixture(t, { leaseMs: 1200 });
  const child = fork(fileURLToPath(new URL('./helpers/lock-holder.mjs', import.meta.url)), [path], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await message(child, 'ready');
  const { jobId } = queue.submit({ delayMs: 0 }, 'lock-renew-intent');
  const claim = queue.claim('test-worker');
  const locked = message(child, 'locked');
  child.send({ type: 'lock', holdMs: 1550 });
  await locked;
  assert.ok(Date.now() < claim.leaseUntil, 'Renewal begins while the old deadline is still live.');
  assert.equal(queue.renew(jobId, 'test-worker', claim.token), false, 'The clock must be sampled after acquiring the writer lock.');
  assert.equal(queue.detail(jobId).leaseUntil, claim.leaseUntil);
  assert.equal(queue.recover(), 1);
  await exited;
});

test('SQLite page exhaustion preserves SQLITE_FULL, rolls back and permits recovery', t => {
  const { queue } = fixture(t);
  const { jobId } = queue.submit({ delayMs: 0 }, 'full-storage-intent');
  const claim = queue.claim('test-worker');
  const pages = queue.db.prepare('PRAGMA page_count').get().page_count;
  queue.db.exec(`PRAGMA max_page_count=${pages}`);
  assert.throws(() => queue.complete(jobId, 'test-worker', claim.token, { payload: 'x'.repeat(300000) }), error => error.errcode === 13, 'Actual SQLITE_FULL must not become a secondary ROLLBACK error.');
  assert.equal(queue.db.isTransaction, false);
  assert.equal(queue.detail(jobId).state, 'running');
  assert.equal(queue.detail(jobId).receipts.length, 0);
  queue.db.exec(`PRAGMA max_page_count=${pages + 1000}`);
  assert.equal(queue.complete(jobId, 'test-worker', claim.token, { recovered: true }).accepted, true);
  assert.equal(queue.detail(jobId).receipts.length, 1);
  assert.equal(queue.evidence().integrity.valid, true);
});

test('a standalone task detail cannot splice running state with a concurrently committed receipt', t => {
  const { queue, path } = fixture(t);
  const other = new Queue(path);
  try {
    const { jobId } = queue.submit({ delayMs: 0 }, 'detail-snapshot-intent');
    const claim = queue.claim('test-worker');
    const original = queue.raw.bind(queue);
    let injected = false;
    queue.raw = id => {
      const row = original(id);
      if (!injected) { injected = true; other.complete(jobId, 'test-worker', claim.token, { done: true }); }
      return row;
    };
    const detail = queue.detail(jobId);
    assert.equal(detail.state, 'running');
    assert.equal(detail.attempts[0].state, 'running');
    assert.equal(detail.receipts.length, 0);
    assert.equal(queue.detail(jobId).state, 'succeeded');
  } finally { other.close(); }
});

test('pruning invalidates a cached experiment even in the same clock bucket', t => {
  let now = 1700000000000;
  const { queue } = fixture(t, { clock: () => now });
  const { experimentId } = queue.experiment('duplicate', 'pruned-report-intent');
  const claim = queue.claim('test-worker');
  queue.complete(claim.id, 'test-worker', claim.token, {});
  now += 31 * 86400000;
  assert.equal(queue.experimentReport(experimentId).verdict.status, 'pass');
  queue.prune();
  assert.throws(() => queue.experimentReport(experimentId), error => error.code === 'NOT_FOUND');
});

test('conditional snapshots observe workers going offline without a new event', async t => {
  const { app } = await appFixture(t);
  let now = 1700000000000;
  app.queue.clock = () => now;
  app.queue.registerWorker('offline-worker', 1, 1);
  const first = await fetch(`${app.url}/api/snapshot`);
  const tag = first.headers.get('etag');
  assert.equal((await first.json()).workers[0].online, true);
  now += 3001;
  const second = await fetch(`${app.url}/api/snapshot`, { headers: { 'If-None-Match': tag } });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).workers[0].online, false);
});

test('conditional snapshots observe retention without an appended event', async t => {
  const { app } = await appFixture(t);
  let now = 1700000000000;
  app.queue.clock = () => now;
  app.queue.registerWorker('retention-worker', 1, 1);
  const job = app.queue.submit({ delayMs: 0 }, 'retention-etag-intent');
  const claim = app.queue.claim('retention-worker');
  app.queue.complete(job.jobId, 'retention-worker', claim.token, {});
  now += 31 * 86400000;
  const first = await fetch(`${app.url}/api/snapshot`);
  const tag = first.headers.get('etag');
  await first.arrayBuffer();
  app.queue.prune();
  const second = await fetch(`${app.url}/api/snapshot`, { headers: { 'If-None-Match': tag } });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).counts.succeeded, 0);
});

test('concurrent close calls await the same completed shutdown', async t => {
  const { app } = await appFixture(t);
  const first = app.close(), second = app.close();
  try {
    await second;
    assert.equal(app.queue.db.isOpen, false, 'A second caller must not report success before draining completes.');
  } finally { await first; }
});

test('a request whose body finishes during shutdown is rejected without a durable write', async t => {
  const { app, database } = await appFixture(t);
  const body = JSON.stringify({ label: 'late shutdown write', delayMs: 0 });
  const accepted = new Promise(resolve => app.server.once('request', resolve));
  const result = new Promise((resolve, reject) => {
    const req = request(`${app.url}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Control-Token': app.token, 'Idempotency-Key': 'shutdown-write-intent' } }, response => {
      let raw = ''; response.on('data', chunk => { raw += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, connection: response.headers.connection, body: JSON.parse(raw) }));
    });
    req.on('error', reject);
    req.write(body.slice(0, 10));
    accepted.then(() => { const closing = app.close(); req.end(body.slice(10)); closing.catch(reject); });
  });
  const response = await result;
  assert.equal(response.status, 503);
  assert.equal(response.body.error.code, 'SHUTTING_DOWN');
  assert.equal(response.connection, 'close');
  await app.close();
  const observer = new Queue(database);
  try { assert.equal(observer.requestStatus('shutdown-write-intent').found, false); }
  finally { observer.close(); }
});

test('failed port binding closes the real SQLite file handles', async t => {
  if (!existsSync('/proc/self/fd')) return t.skip('Linux file-descriptor verification.');
  const directory = mkdtempSync(join(tmpdir(), 'faultline-bind-failure-'));
  const database = join(directory, 'queue.sqlite');
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const handles = () => readdirSync('/proc/self/fd').filter(fd => { try { return readlinkSync(`/proc/self/fd/${fd}`).startsWith(database); } catch { return false; } }).length;
  t.after(async () => { await new Promise(resolve => listener.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const before = handles();
  await assert.rejects(startServer({ port: listener.address().port, database, workers: 0, quiet: true }), error => error.code === 'EADDRINUSE');
  assert.equal(handles(), before);
});

test('a real worker storage-commit error is not reported as a handler failure', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-commit-failure-'));
  const app = await startServer({ port: 0, database: join(directory, 'queue.sqlite'), workers: 1, quiet: true });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  app.queue.db.exec("CREATE TRIGGER block_commit BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'storage-commit-fault'); END");
  const { jobId } = app.queue.submit({ delayMs: 0 }, 'worker-storage-fault');
  await until(() => app.queue.detail(jobId).attempts.length === 1);
  await sleep(150);
  assert.equal(app.queue.detail(jobId).state, 'running', 'Storage failure leaves the lease for recovery; it is not a business retry.');
  assert.equal(app.queue.detail(jobId).events.some(e => e.type === 'job.retry_scheduled'), false);
  app.queue.db.exec('DROP TRIGGER block_commit');
  await until(() => app.queue.detail(jobId).state === 'succeeded');
  assert.deepEqual(app.queue.detail(jobId).attempts.map(a => a.state), ['expired', 'succeeded']);
  assert.equal(app.queue.detail(jobId).receipts.length, 1);
  assert.equal(app.queue.evidence().integrity.valid, true);
});

test('HTTP page exhaustion returns STORAGE_FULL and the same request key can recover', async t => {
  const { app } = await appFixture(t);
  const pages = app.queue.db.prepare('PRAGMA page_count').get().page_count;
  app.queue.db.exec(`PRAGMA max_page_count=${pages}`);
  const headers = { 'Content-Type': 'application/json', 'X-Control-Token': app.token, 'Idempotency-Key': 'http-full-intent' };
  const body = JSON.stringify({ text: 'x'.repeat(12000), delayMs: 0 });
  const first = await fetch(`${app.url}/api/jobs`, { method: 'POST', headers, body });
  assert.equal(first.status, 507);
  assert.equal((await first.json()).error.code, 'STORAGE_FULL');
  assert.equal(app.queue.requestStatus('http-full-intent').found, false);
  app.queue.db.exec(`PRAGMA max_page_count=${pages + 1000}`);
  const second = await fetch(`${app.url}/api/jobs`, { method: 'POST', headers, body });
  assert.equal(second.status, 201);
  assert.equal((await second.json()).deduplicated, false);
  assert.equal(app.queue.snapshot().counts.queued, 1);
  assert.equal(app.queue.evidence().integrity.valid, true);
});

test('HTTP writer contention returns STORAGE_BUSY without saving a false success', { timeout: 6000 }, async t => {
  const { app, database } = await appFixture(t);
  app.queue.db.exec('PRAGMA busy_timeout=50');
  const child = fork(fileURLToPath(new URL('./helpers/lock-holder.mjs', import.meta.url)), [database], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  await message(child, 'ready');
  const locked = message(child, 'locked'); child.send({ type: 'lock', holdMs: 700 }); await locked;
  const headers = { 'Content-Type': 'application/json', 'X-Control-Token': app.token, 'Idempotency-Key': 'http-busy-intent' };
  const first = await fetch(`${app.url}/api/jobs`, { method: 'POST', headers, body: '{}' });
  assert.equal(first.status, 503);
  assert.equal(first.headers.get('retry-after'), '1');
  assert.equal((await first.json()).error.code, 'STORAGE_BUSY');
  await exited;
  assert.equal(app.queue.requestStatus('http-busy-intent').found, false);
  const second = await fetch(`${app.url}/api/jobs`, { method: 'POST', headers, body: '{}' });
  assert.equal(second.status, 201);
  await second.arrayBuffer();
});

test('worker-stop metadata failure still releases processes, IPC and SQLite', { timeout: 6000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-stop-failure-'));
  const app = await startServer({ port: 0, database: join(directory, 'queue.sqlite'), workers: 1, quiet: true });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  await until(() => app.queue.snapshot().workers.some(w => w.online));
  app.queue.db.exec("CREATE TRIGGER block_stop BEFORE UPDATE ON workers WHEN NEW.phase='stopped' BEGIN SELECT RAISE(ABORT, 'stop-metadata-fault'); END");
  const started = performance.now();
  await app.close();
  assert.ok(performance.now() - started < 3000, 'Cleanup must not fall through to forced killing.');
  assert.equal(app.children.size, 0);
  assert.equal(app.queue.db.isOpen, false);
});
