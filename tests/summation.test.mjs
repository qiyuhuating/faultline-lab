import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execute } from '../src/handlers.mjs';
import { startServer } from '../src/server.mjs';

function verify(text, expected) {
  const values = text.split(',').map(Number);
  const result = execute('csv_summary', text);
  assert.deepEqual(result, {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    sum: expected,
    mean: expected / values.length,
    sha256: createHash('sha256').update(text).digest('hex'),
  }, text.slice(0, 120));
  return result;
}

function permutations(a, b, c) {
  return [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
}

test('numeric summaries retain a small residual in every order of large cancelling inputs', () => {
  for (const residual of [2 ** -20, Number.MIN_VALUE, -(2 ** -20), -Number.MIN_VALUE]) {
    for (const values of permutations(1e12, residual, -1e12)) verify(values.join(','), residual);
  }
});

test('numeric summaries round the exact binary sum once, including ties and subnormal values', () => {
  const cases = [
    [[1, 2 ** -53], 1],
    [[1, 2 ** -53, Number.MIN_VALUE], 1 + 2 ** -52],
    [[1 + 2 ** -52, 2 ** -53], 1 + 2 ** -51],
    [[-1, -(2 ** -53)], -1],
    [[-1, -(2 ** -53), -Number.MIN_VALUE], -1 - 2 ** -52],
    [[-1 - 2 ** -52, -(2 ** -53)], -1 - 2 ** -51],
    [[Number.MIN_VALUE, Number.MIN_VALUE], Number.MIN_VALUE * 2],
    [[Number.MIN_VALUE, -Number.MIN_VALUE], 0],
    [[0, -0], 0],
    [[1e12, 1e12], 2e12],
    [[2, 4, 6], 12],
    [[0.1, 0.2], 0.30000000000000004],
  ];
  for (const [values, expected] of cases) verify(values.join(','), expected);
});

test('the 2,000-value limit preserves repeated residuals and exact cancellation', () => {
  const positive = `1e12,${Array(1998).fill('1e-6').join(',')},-1e12`;
  assert.ok(Buffer.byteLength(positive) <= 12000);
  verify(positive, 1998 * 1e-6);
  const balanced = `1e12,${Array(999).fill('1e-6').join(',')},${Array(999).fill('-1e-6').join(',')},-1e12`;
  assert.ok(Buffer.byteLength(balanced) <= 12000);
  verify(balanced, 0);
  assert.throws(() => execute('csv_summary', Array(2001).fill('1').join(',')), error => error.code === 'INPUT_INVALID');
  for (const text of ['NaN', 'Infinity', '-Infinity', '1000000000001', '']) {
    assert.throws(() => execute('csv_summary', text), error => error.code === 'INPUT_INVALID');
  }
});

test('seeded numeric permutations agree with an independent fixed-grid integer oracle', () => {
  const scale = 2 ** 20;
  for (let seed = 1; seed <= 128; seed++) {
    let state = seed;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
    const values = [];
    for (let i = 0; i < 64; i++) {
      const large = 900000000000 + random();
      values.push(large, (random() % 2049 - 1024) / scale, -large);
    }
    // Inputs lie on a known 2^-20 grid; this oracle never inspects float bits.
    const exact = values.reduce((total, value) => total + BigInt(value * scale), 0n);
    const expected = Number(exact) / scale;
    for (let order = 0; order < 4; order++) {
      for (let i = values.length - 1; i > 0; i--) {
        const j = random() % (i + 1);
        [values[i], values[j]] = [values[j], values[i]];
      }
      verify(values.join(','), expected);
    }
  }
});

test('a real HTTP worker commits the corrected numeric result once and retains it after restart', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'faultline-numeric-http-'));
  const options = { port: 0, database: join(directory, 'queue.sqlite'), quiet: true };
  let app = await startServer({ ...options, workers: 1 });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const text = `1e12,${Array(1998).fill('1e-6').join(',')},-1e12`;
  const key = 'numeric-http-intent';
  const response = await fetch(app.url + '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Control-Token': app.token, 'Idempotency-Key': key },
    body: JSON.stringify({ label: 'numeric cancellation', kind: 'csv_summary', text, delayMs: 0 }),
  });
  assert.equal(response.status, 201);
  const { jobId } = await response.json();
  let job;
  const deadline = Date.now() + 15000;
  do {
    const response = await fetch(app.url + '/api/jobs/' + jobId);
    assert.equal(response.status, 200);
    ({ job } = await response.json());
    if (job.state === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(job.state, 'succeeded');
  const expected = { count: 2000, min: -1e12, max: 1e12, sum: 1998 * 1e-6, mean: (1998 * 1e-6) / 2000, sha256: createHash('sha256').update(text).digest('hex') };
  assert.deepEqual(job.result, expected);
  const receipt = app.queue.db.prepare('SELECT result FROM receipts WHERE job_id=? AND generation=0').get(jobId);
  assert.deepEqual(JSON.parse(receipt.result), expected);
  assert.equal(job.receipts.length, 1);
  const winner = job.attempts.at(-1);
  assert.equal(winner.state, 'succeeded');
  assert.equal(winner.token, job.token);
  assert.equal(winner.ended_at, job.completedAt);
  assert.deepEqual(job.receipts, [{ generation: job.generation, token: job.token, committed_at: job.completedAt }]);
  assert.equal(app.queue.evidence().integrity.valid, true);
  assert.equal(app.queue.diagnostics().verdict, 'pass');
  await app.close();
  app = await startServer({ ...options, workers: 0 });
  const { job: reopened } = await (await fetch(app.url + '/api/jobs/' + jobId)).json();
  assert.deepEqual(reopened.result, expected);
  assert.deepEqual(reopened.receipts, job.receipts);
  const reopenedReceipt = app.queue.db.prepare('SELECT result FROM receipts WHERE job_id=? AND generation=0').get(jobId);
  assert.deepEqual(JSON.parse(reopenedReceipt.result), expected);
  const lookup = await (await fetch(app.url + '/api/requests/' + key)).json();
  assert.equal(lookup.found, true);
  assert.equal(lookup.result.jobId, jobId);
  assert.equal(app.queue.evidence().integrity.valid, true);
  assert.equal(app.queue.diagnostics().verdict, 'pass');
});
