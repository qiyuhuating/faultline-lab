import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../src/server.mjs';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Queue } from '../src/queue.mjs';
import { evaluateExperiment } from '../public/proof.mjs';

async function until(predicate, timeout = 14000) {
  const start = performance.now();
  while (performance.now() - start < timeout) {
    const result = predicate();
    if (result) return result;
    await sleep(30);
  }
  throw new Error('Timed out waiting for a real worker process.');
}

test('a live stalled worker submits after takeover and is actually fenced out', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-zombie-'));
  const instance = await startServer({ port: 0, database: join(directory, 'queue.sqlite'), workers: 3, quiet: true });
  t.after(async () => { await instance.close(); rmSync(directory, { recursive: true, force: true }); });
  const { experimentId, jobIds } = instance.queue.experiment('fence', 'real-zombie-worker-key');
  await until(() => instance.queue.experimentReport(experimentId).verdict.status === 'pass');
  const job = instance.queue.detail(jobIds[0]);
  assert.equal(job.receipts.length, 1);
  assert.deepEqual(job.attempts.map(a => a.state), ['expired', 'succeeded']);
  const rejected = job.events.find(e => e.type === 'commit.rejected');
  assert.equal(rejected.data.workerId, job.attempts[0].worker_id);
  assert.equal(rejected.data.token, 1);
  assert.equal(rejected.data.currentToken, 2);
  assert.ok(job.events.find(e => e.type === 'job.succeeded').seq < rejected.seq, 'The obsolete process really wakes after the new owner commits.');
});

test('four independent processes drain 240 tasks with no missing or duplicate receipts', { timeout: 60000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-process-'));
  const instance = await startServer({ port: 0, database: join(directory, 'queue.sqlite'), workers: 4, quiet: true });
  t.after(async () => { await instance.close(); rmSync(directory, { recursive: true, force: true }); });
  instance.queue.setPaused(true, 'process-stage-backlog');
  await until(() => instance.queue.snapshot().workers.filter(w => w.online).length === 4);
  const ids = [];
  for (let i = 0; i < 240; i++) ids.push(instance.queue.submit({ label: `race ${i}`, text: `${i}`, delayMs: 0 }, `process-job-${i}`).jobId);
  assert.equal(instance.queue.db.prepare('SELECT COUNT(*) n FROM jobs WHERE attempt!=0').get().n, 0);
  // Stage the backlog before timing worker competition; submission itself holds writer locks.
  instance.queue.setPaused(false, 'process-resume-backlog');
  await until(() => instance.queue.snapshot().counts.succeeded === 240, 40000);
  assert.equal(instance.queue.db.prepare('SELECT COUNT(*) n FROM receipts').get().n, 240);
  assert.equal(instance.queue.db.prepare("SELECT COUNT(*) n FROM jobs WHERE attempt!=1").get().n, 0);
  const owners = instance.queue.db.prepare('SELECT DISTINCT worker_id FROM attempts').all();
  assert.ok(owners.length >= 2, 'Multiple independent processes actually participate.');
  assert.equal(instance.queue.evidence().integrity.valid, true);
  assert.equal(new Set(ids).size, 240);
});

test('SIGKILL is real: expired attempt is replaced and only one receipt is committed', { timeout: 20000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-crash-'));
  const instance = await startServer({ port: 0, database: join(directory, 'queue.sqlite'), workers: 3, quiet: true });
  t.after(async () => { await instance.close(); rmSync(directory, { recursive: true, force: true }); });
  const { experimentId, jobIds } = instance.queue.experiment('crash', 'process-crash-intent');
  const id = jobIds[0];
  await until(() => instance.queue.detail(id).state === 'succeeded');
  const job = instance.queue.detail(id);
  assert.equal(job.attempt, 2);
  assert.deepEqual(job.attempts.map(a => a.state), ['expired', 'succeeded']);
  assert.notEqual(job.attempts[0].worker_id, job.attempts[1].worker_id);
  assert.equal(job.receipts.length, 1);
  const exited = job.events.find(e => e.type === 'worker.stopped' && e.data.workerId === job.attempts[0].worker_id);
  assert.ok(exited, 'The controller observed the crashed process exit.');
  assert.equal(exited.data.reason, process.platform === 'win32' ? 'exit:1' : 'signal:SIGKILL');
  assert.equal(exited.data.platform, process.platform);
  const report = instance.queue.experimentReport(experimentId);
  assert.equal(report.verdict.status, 'pass');
  // Exercise the Windows evidence contract with the observed crash's matching records.
  const portable = structuredClone(report.jobs);
  const stopped = portable[0].events.find(event => event.type === 'worker.stopped' && event.data.workerId === job.attempts[0].worker_id);
  stopped.data.platform = 'win32';
  stopped.data.reason = 'exit:1';
  assert.equal(evaluateExperiment(report.experiment, portable).status, 'pass');
  for (const [name, alter] of [
    ['missing crash request', (events, requested) => events.splice(events.indexOf(requested), 1)],
    ['different crashed worker', (_events, requested) => { requested.data.workerId = 'unrelated-worker'; }],
    ['different crashed token', (_events, requested) => { requested.data.token++; }],
    ['different requested signal', (_events, requested) => { requested.data.signal = 'SIGTERM'; }],
    ['request after exit', (_events, requested, exit) => { requested.seq = exit.seq + 1; }],
    ['different platform', (_events, _requested, exit) => { exit.data.platform = 'linux'; }],
    ['different exit code', (_events, _requested, exit) => { exit.data.reason = 'exit:0'; }],
    ['missing actual exit', (events, _requested, exit) => events.splice(events.indexOf(exit), 1)],
  ]) {
    const altered = structuredClone(portable);
    const events = altered[0].events;
    const requested = events.find(event => event.type === 'worker.crash.requested');
    const exit = events.find(event => event.type === 'worker.stopped' && event.data.workerId === job.attempts[0].worker_id);
    alter(events, requested, exit);
    assert.equal(evaluateExperiment(report.experiment, altered).checks.find(check => check.id === 'kill').status, 'fail', name);
  }
  assert.equal(instance.queue.complete(id, job.attempts[0].worker_id, job.attempts[0].token, { stale: true }).accepted, false);
  assert.equal(instance.queue.evidence().integrity.valid, true);
});

test('controller restart preserves tasks, pause state and idempotency records', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-restart-'));
  const database = join(directory, 'queue.sqlite');
  let instance;
  try {
    instance = await startServer({ port: 0, database, workers: 0, quiet: true });
    const body = { label: 'survive restart', text: 'persistent', delayMs: 0 };
    const first = instance.queue.submit(body, 'restart-create-key');
    instance.queue.setPaused(true, 'restart-pause-key');
    const oldToken = instance.token;
    await instance.close();
    instance = await startServer({ port: 0, database, workers: 2, quiet: true });
    assert.notEqual(instance.token, oldToken);
    assert.equal(instance.queue.snapshot().paused, true);
    assert.equal(instance.queue.submit(body, 'restart-create-key').jobId, first.jobId);
    instance.queue.setPaused(false, 'restart-resume-key');
    await until(() => instance.queue.detail(first.jobId).state === 'succeeded');
    assert.equal(instance.queue.snapshot().metrics.receipts, 1);
  } finally {
    await instance?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('hard controller death disconnects orphan workers; a new controller resumes persisted jobs', { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-parent-death-'));
  const database = join(directory, 'queue.sqlite');
  const child = fork(fileURLToPath(new URL('../src/server.mjs', import.meta.url)), ['--port=0', '--workers=1', `--db=${database}`], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', () => {});
  let observer;
  let restarted;
  try {
    const url = await until(() => /http:\/\/127\.0\.0\.1:\d+/.exec(log)?.[0]);
    observer = new Queue(database);
    await until(() => observer.snapshot().workers.some(w => w.online));
    const workerId = observer.snapshot().workers[0].id;
    const dead = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await dead;
    const workerPid = observer.snapshot().workers.find(w => w.id === workerId).pid;
    await until(() => {
      if (process.platform !== 'win32') return observer.db.prepare('SELECT phase FROM workers WHERE id=?').get(workerId)?.phase === 'stopped';
      let gone = false;
      try { process.kill(workerPid, 0); } catch (error) { gone = error.code === 'ESRCH'; }
      return gone && observer.snapshot().workers.find(w => w.id === workerId)?.online === false;
    }, 5000);
    const { jobId } = observer.submit({ label: 'after parent death', text: 'durable', delayMs: 0 }, 'hard-restart-key');
    await sleep(150);
    assert.equal(observer.detail(jobId).state, 'queued', 'No orphan process continues claiming.');
    restarted = await startServer({ port: 0, database, workers: 2, quiet: true });
    await until(() => observer.detail(jobId).state === 'succeeded');
    assert.equal(observer.detail(jobId).receipts.length, 1);
    assert.equal(observer.evidence().integrity.valid, true);
    assert.ok(url.startsWith('http://127.0.0.1:'));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const dead = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await dead;
    }
    await restarted?.close();
    observer?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
