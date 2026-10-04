import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../src/server.mjs';
import { digest } from '../src/validation.mjs';
import { verifyEvidence } from '../public/evidence.mjs';

const SCENARIOS = ['crash', 'fence', 'retry', 'duplicate', 'dead', 'response-loss', 'burst'];
const version = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
async function read(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`GET returned ${response.status}`);
  return response.json();
}
async function post(app, path, body, key) {
  const response = await fetch(app.url + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Control-Token': app.token,
      'Idempotency-Key': key,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const result = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(`POST returned ${response.status}: ${result.error?.code}`), {
      status: response.status,
      code: result.error?.code,
    });
  return result;
}
async function until(fn, timeout) {
  const end = performance.now() + timeout;
  while (true) {
    const result = await fn();
    if (result) return result;
    if (performance.now() > end) throw new Error('Acceptance deadline exceeded');
    await sleep(50);
  }
}
function require(condition, message) {
  if (!condition) throw new Error(message);
}
export async function verifyLab({
  output = 'test-results/verification',
  workers = 3,
  timeoutMs = 20000,
  scenarios = SCENARIOS,
  onProgress = () => {},
} = {}) {
  require(Number.isInteger(workers) &&
    workers >= 2 &&
    workers <= 8, 'Verification requires 2–8 independent workers.');
  require(Number.isInteger(timeoutMs) &&
    timeoutMs >= 100 &&
    timeoutMs <= 120000, 'timeoutMs must be 100–120000.');
  require(Array.isArray(scenarios) &&
    scenarios.length > 0 &&
    scenarios.every((s) => SCENARIOS.includes(s)) &&
    new Set(scenarios).size === scenarios.length, 'Unknown or repeated scenario.');
  const directory = mkdtempSync(join(tmpdir(), 'faultline-verify-'));
  const artifact = resolve(
    output,
    `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
  );
  mkdirSync(artifact, { recursive: true });
  const report = {
    format: 'faultline-verification-v1',
    version,
    startedAt: Date.now(),
    status: 'running',
    runtime: process.versions,
    workers,
    scenarios: [],
    checks: [],
    notice:
      'Real local processes and HTTP requests; internal result consistency, not arbitrary external exactly-once delivery.',
  };
  const requests = [];
  let app;
  let failure;
  try {
    app = await startServer({
      port: 0,
      database: join(directory, 'queue.sqlite'),
      workers,
      quiet: true,
    });
    for (const scenario of scenarios) {
      const key = randomUUID(),
        started = performance.now();
      let result;
      try {
        result = await post(app, '/api/experiments', { scenario }, key);
      } catch (error) {
        const lookup = await read(app.url + '/api/requests/' + key);
        if (!lookup.found || !lookup.result) throw error;
        result = lookup.result;
      }
      requests.push({ key, experimentId: result.experimentId });
      if (scenario === 'duplicate') {
        const duplicates = await Promise.all([
          post(app, '/api/experiments', { scenario }, key),
          post(app, '/api/experiments', { scenario }, key),
        ]);
        require(duplicates.every(
          (d) => d.deduplicated === true && d.experimentId === result.experimentId,
        ), 'Concurrent duplicate requests must preserve the original experiment.');
      }
      let final = await until(async () => {
        const current = await read(app.url + '/api/experiments/' + result.experimentId);
        if (current.verdict.status === 'fail') throw new Error(`Failed proof: ${scenario}`);
        return current.verdict.status === 'pass' ? current : null;
      }, timeoutMs);
      const initial = final;
      if (scenario === 'dead') {
        const job = final.jobs[0];
        require(job.state === 'dead', 'Dead-letter proof must precede replay.');
        await post(
          app,
          `/api/jobs/${job.id}/transitions`,
          { action: 'replay', expectedRevision: job.revision, clearFaults: true },
          randomUUID(),
        );
        final = await until(async () => {
          const current = await read(app.url + '/api/experiments/' + result.experimentId);
          if (current.verdict.status === 'fail') throw new Error('Dead-letter replay failed.');
          return current.verdict.status === 'pass' && current.jobs[0].generation === 1
            ? current
            : null;
        }, timeoutMs);
        require(final.jobs[0].receipts.length === 1 &&
          final.jobs[0].attempts.length ===
            4, 'Replay must retain three failed attempts and one new winning attempt.');
        report.checks.push({ id: 'dead-replay', status: 'pass' });
      }
      report.scenarios.push({
        scenario,
        durationMs: Math.round(performance.now() - started),
        initial,
        final,
      });
      onProgress(`${scenario}: PASS`);
    }
    const submitted = await post(
      app,
      '/api/jobs',
      { label: 'Cancellation boundary', delayMs: 1500 },
      randomUUID(),
    );
    const running = await until(async () => {
      const { job } = await read(app.url + '/api/jobs/' + submitted.jobId);
      return job.state === 'running' ? job : null;
    }, timeoutMs);
    await post(
      app,
      `/api/jobs/${running.id}/transitions`,
      { action: 'cancel', expectedRevision: running.revision },
      randomUUID(),
    );
    let conflicted = false;
    try {
      await post(
        app,
        `/api/jobs/${running.id}/transitions`,
        { action: 'cancel', expectedRevision: running.revision },
        randomUUID(),
      );
    } catch (error) {
      conflicted = error.code === 'REVISION_CONFLICT';
    }
    require(conflicted, 'A stale HTTP revision must return Conflict.');
    await sleep(1800);
    const { job: cancelled } = await read(app.url + '/api/jobs/' + running.id);
    require(cancelled.state === 'cancelled' &&
      cancelled.receipts.length === 0 &&
      cancelled.token > running.token, 'Cancelled in-flight work must never commit a receipt.');
    report.checks.push({ id: 'in-flight-cancel-and-conflict', status: 'pass' });
    onProgress('in-flight cancel / revision: PASS');
    const before = await read(app.url + '/api/evidence');
    await verifyEvidence(before, digest);
    await app.close();
    app = await startServer({
      port: 0,
      database: join(directory, 'queue.sqlite'),
      workers,
      quiet: true,
    });
    for (const request of requests) {
      const lookup = await read(app.url + '/api/requests/' + request.key);
      require(lookup.found &&
        lookup.result.experimentId ===
          request.experimentId, 'Controller restart must preserve durable request identities.');
    }
    const evidence = await read(app.url + '/api/evidence');
    await verifyEvidence(evidence, digest);
    require(before.events.every(
      (event, i) => evidence.events[i]?.hash === event.hash,
    ), 'Restart must preserve every original event hash.');
    report.checks.push({ id: 'controller-restart', status: 'pass' });
    onProgress('controller restart: PASS');
    const diagnostics = await read(app.url + '/api/diagnostics');
    require(diagnostics.verdict === 'pass', 'Final semantic diagnostics must pass.');
    report.checks.push({ id: 'semantic-diagnostics', status: 'pass' });
    writeFileSync(join(artifact, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
    writeFileSync(join(artifact, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2) + '\n');
    report.status = 'pass';
  } catch (error) {
    report.status = 'fail';
    report.failure = { message: error.message, code: error.code ?? null };
    failure = error;
  } finally {
    if (app)
      try {
        await app.close();
      } catch (error) {
        report.status = 'fail';
        report.cleanupFailure = error.message;
        failure ??= error;
      }
    report.finishedAt = Date.now();
    report.durationMs = report.finishedAt - report.startedAt;
    writeFileSync(join(artifact, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    rmSync(directory, { recursive: true, force: true });
  }
  if (failure) throw Object.assign(failure, { reportPath: join(artifact, 'report.json') });
  return { report, artifact };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const match = /^--(output|workers|timeout-ms|scenario)=(.+)$/.exec(arg);
      if (!match)
        throw new Error(
          'Usage: node tools/verify-lab.mjs [--output=test-results/verification] [--workers=3] [--timeout-ms=20000] [--scenario=all]',
        );
      return [match[1], match[2]];
    }),
  );
  try {
    const result = await verifyLab({
      output: args.output ?? 'test-results/verification',
      workers: Number(args.workers ?? 3),
      timeoutMs: Number(args['timeout-ms'] ?? 20000),
      scenarios: args.scenario && args.scenario !== 'all' ? [args.scenario] : SCENARIOS,
      onProgress: console.log,
    });
    console.log(`PASS / ${result.report.durationMs} ms / ${result.artifact}`);
  } catch (error) {
    console.error(`FAIL / ${error.message} / ${error.reportPath ?? 'no report'}`);
    process.exitCode = 1;
  }
}
