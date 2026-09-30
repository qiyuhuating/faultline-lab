import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../src/server.mjs';
import { verifyEvidence } from '../public/evidence.mjs';
import { digest } from '../src/validation.mjs';

const directory = mkdtempSync(join(tmpdir(), 'faultline-recording-'));
const instance = await startServer({ port: 0, database: join(directory, 'queue.sqlite'), workers: 3, quiet: true });
const reports = [];
try {
  for (const scenario of ['crash', 'fence', 'retry', 'duplicate', 'dead', 'response-loss']) {
    const requestKey = randomUUID();
    let result;
    try {
      const response = await fetch(`${instance.url}/api/experiments`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Control-Token': instance.token, 'Idempotency-Key': requestKey }, body: JSON.stringify({ scenario }) });
      if (!response.ok) throw new Error(await response.text());
      result = await response.json();
    } catch (error) {
      if (scenario !== 'response-loss') throw error;
      const status = instance.queue.requestStatus(requestKey);
      if (!status.found) throw error;
      result = status.result;
    }
    const deadline = performance.now() + 18000;
    while (true) {
      const report = instance.queue.experimentReport(result.experimentId);
      if (report.verdict.status === 'fail') throw new Error(`Acceptance failed: ${scenario}`);
      if (report.verdict.status === 'pass') { reports.push(report); break; }
      if (performance.now() > deadline) throw new Error(`Recording timed out: ${scenario}`);
      await sleep(100);
    }
    console.log(`Recorded real ${scenario} experiment: PASS`);
  }
  const evidence = instance.queue.evidence();
  await verifyEvidence(evidence, digest);
  const bundle = { format: 'faultline-recorded-traces-v1', recordedAt: Date.now(), environment: { node: process.version, platform: process.platform, arch: process.arch, workers: 3 }, notice: 'Recorded from real local worker processes. Playback does not execute or kill processes.', reports, evidence };
  mkdirSync(new URL('../showcase/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../showcase/traces.json', import.meta.url), `${JSON.stringify(bundle, null, 2)}\n`);
  console.log(`Saved ${reports.length} reports and ${evidence.events.length} chain-verified events.`);
} finally {
  await instance.close();
  rmSync(directory, { recursive: true, force: true });
}
