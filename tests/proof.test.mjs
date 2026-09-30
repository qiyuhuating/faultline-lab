import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from '../src/queue.mjs';
import { evaluateExperiment } from '../public/proof.mjs';
import { verifyEvidence } from '../public/evidence.mjs';
import { digest } from '../src/validation.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('unfinished experiments remain pending; real completion passes their checks', () => {
  let now = 1700000000000;
  const queue = new Queue(':memory:', { clock: () => now });
  try {
    queue.registerWorker('worker-a', 1, 1);
    const { experimentId } = queue.experiment('duplicate', 'proof-duplicate-key');
    assert.equal(queue.experimentReport(experimentId).verdict.status, 'running');
    const job = queue.claim('worker-a');
    queue.complete(job.id, 'worker-a', job.token, { ok: true });
    const report = queue.experimentReport(experimentId);
    assert.equal(report.verdict.status, 'pass');
    assert.equal(queue.experiment('duplicate', 'proof-duplicate-key').experimentId, experimentId);
    assert.equal(queue.experiments().length, 1);
    assert.equal(queue.experiments()[0].jobs[0].definition, undefined, 'Snapshot omits task input and history.');
    const tampered = structuredClone(report.jobs);
    tampered[0].receipts.push(tampered[0].receipts[0]);
    assert.equal(evaluateExperiment(report.experiment, tampered, now).status, 'fail');
    tampered[0].receipts = [{ generation: 0, token: 999 }];
    assert.equal(evaluateExperiment(report.experiment, tampered, now).status, 'fail');
  } finally { queue.close(); }
});

test('dead-letter proof remains available after a successful new generation', () => {
  let now = 1700000000000;
  const queue = new Queue(':memory:', { clock: () => now });
  try {
    queue.registerWorker('worker-a', 1, 1);
    const { experimentId, jobIds } = queue.experiment('dead', 'proof-dead-key');
    for (let i = 0; i < 3; i++) {
      const claim = queue.claim('worker-a');
      queue.fail(claim.id, 'worker-a', claim.token, { code: 'INJECTED_FAILURE' });
      now += 10000;
    }
    assert.equal(queue.experimentReport(experimentId).verdict.status, 'pass');
    queue.transition(jobIds[0], 'replay', queue.detail(jobIds[0]).revision, 'proof-replay-key', { clearFaults: true });
    assert.equal(queue.experimentReport(experimentId).verdict.status, 'running');
    const claim = queue.claim('worker-a');
    queue.complete(claim.id, 'worker-a', claim.token, { ok: true });
    assert.equal(queue.experimentReport(experimentId).verdict.status, 'pass');
  } finally { queue.close(); }
});

test('missing stale-worker rejection becomes a failed proof, never an endless green pending state', () => {
  const experiment = { id: 'test', scenario: 'fence', createdAt: 1000, jobIds: ['job'], submissions: 1 };
  const jobs = [{ id: 'job', state: 'succeeded', attempts: [{ generation: 0, worker_id: 'old', state: 'expired', token: 1 }, { generation: 0, worker_id: 'new', state: 'succeeded', token: 2 }], receipts: [{ generation: 0, token: 2 }], events: [] }];
  assert.equal(evaluateExperiment(experiment, jobs, 10000).status, 'running');
  assert.equal(evaluateExperiment(experiment, jobs, 17000).status, 'fail');
  jobs[0].events.push({ type: 'commit.rejected', data: { token: 1, currentToken: 2 } });
  assert.equal(evaluateExperiment(experiment, jobs, 17000).status, 'pass');
});

test('expired experiment records are pruned together with their retained jobs', () => {
  let now = 1700000000000;
  const queue = new Queue(':memory:', { clock: () => now });
  try {
    queue.registerWorker('worker-a', 1, 1);
    queue.experiment('duplicate', 'proof-retention-key');
    const job = queue.claim('worker-a');
    queue.complete(job.id, 'worker-a', job.token, {});
    now += 31 * 86400000;
    queue.prune();
    assert.equal(queue.experiments().length, 0);
  } finally { queue.close(); }
});

test('portable verifier rejects changed payloads, wrong counts, gaps and missing structure', async () => {
  const queue = new Queue(':memory:');
  try {
    queue.experiment('duplicate', 'portable-chain-key');
    const evidence = queue.evidence();
    assert.equal((await verifyEvidence(evidence, digest)).valid, true);
    for (const change of [e => { e.events[0].data.label = 'tampered'; }, e => { e.integrity.count++; }, e => { e.events.splice(1, 1); }, e => { e.integrity = null; }]) {
      const altered = structuredClone(evidence); change(altered);
      await assert.rejects(() => verifyEvidence(altered, digest));
    }
  } finally { queue.close(); }
});

test('a concurrent commit cannot splice two database versions into one experiment proof', () => {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-read-snapshot-'));
  const path = join(directory, 'queue.sqlite');
  const queue = new Queue(path), other = new Queue(path);
  try {
    queue.registerWorker('worker-a', 1, 1);
    const { experimentId } = queue.experiment('duplicate', 'consistent-proof-key');
    const claim = queue.claim('worker-a');
    const original = queue.raw.bind(queue);
    let injected = false;
    queue.raw = id => {
      const row = original(id);
      if (!injected) { injected = true; other.complete(claim.id, 'worker-a', claim.token, { durable: true }); }
      return row;
    };
    const report = queue.experimentReport(experimentId);
    assert.equal(report.jobs[0].state, 'running');
    assert.equal(report.jobs[0].attempts[0].state, 'running');
    assert.equal(report.jobs[0].receipts.length, 0);
    assert.equal(report.verdict.status, 'running');
    assert.equal(queue.experimentReport(experimentId).verdict.status, 'pass');
    assert.throws(() => queue.experimentReport('missing'), error => error.code === 'NOT_FOUND');
    assert.equal(queue.evidence().integrity.valid, true, 'Failed reads release the read transaction.');
  } finally { other.close(); queue.close(); rmSync(directory, { recursive: true, force: true }); }
});
