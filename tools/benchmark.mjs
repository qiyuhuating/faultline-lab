import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, availableParallelism, platform, arch } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../src/server.mjs';
import { Queue } from '../src/queue.mjs';

const count = Number(process.argv.find(a => a.startsWith('--jobs='))?.split('=')[1] ?? 500);
if (!Number.isSafeInteger(count) || count < 1 || count > 5000) throw new Error('--jobs must be 1–5000.');
const output = process.argv.find(a => a.startsWith('--output='))?.slice(9);
const directory = mkdtempSync(join(tmpdir(), 'faultline-benchmark-'));
let instance;
try {
  const queue = new Queue(join(directory, 'queue.sqlite'));
  const started = performance.now();
  try {
    for (let i = 0; i < count; i++) queue.submit({ label: `benchmark ${i}`, text: 'A tiny deterministic handler.', delayMs: 0 }, `benchmark-${i}`);
  } finally { queue.close(); }
  const submitted = performance.now();
  // Prepare the backlog before workers compete; submission and startup stay timed.
  instance = await startServer({ port: 0, database: join(directory, 'queue.sqlite'), workers: 4, quiet: true });
  while (instance.queue.snapshot().counts.succeeded !== count) {
    if (performance.now() - started > 60000) throw new Error('Benchmark exceeded 60 seconds.');
    await sleep(40);
  }
  const elapsed = performance.now() - started;
  const snapshot = instance.queue.snapshot();
  const report = {
    measuredAt: new Date().toISOString(), scope: 'single-host local microbenchmark, tiny SHA-256 tasks, no external I/O',
    environment: { node: process.version, sqlite: instance.queue.db.prepare('SELECT sqlite_version() version').get().version, platform: platform(), arch: arch(), availableCPUs: availableParallelism() },
    workers: 4, jobs: count, submissionMs: Math.round(submitted - started), endToEndMs: Math.round(elapsed),
    jobsPerSecond: Math.round(count / elapsed * 1000 * 10) / 10,
    succeeded: snapshot.counts.succeeded, receipts: snapshot.metrics.receipts,
    attempts: instance.queue.db.prepare('SELECT COUNT(*) n FROM attempts').get().n,
    eventChainValid: instance.queue.evidence().integrity.valid,
    durability: 'SQLite WAL, synchronous=FULL',
    submissionMode: 'backlog staged before worker startup',
    note: 'Not a production capacity claim; rerun on the target hardware.'
  };
  if (report.succeeded !== count || report.receipts !== count || !report.eventChainValid) throw new Error('Integrity gate failed.');
  console.log(JSON.stringify(report, null, 2));
  if (output) writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
} finally {
  await instance?.close();
  rmSync(directory, { recursive: true, force: true });
}
