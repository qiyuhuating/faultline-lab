import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SqliteStore } from '../src/storage/sqlite-store.ts';
import { EventLedger } from '../src/services/event-ledger.ts';
import { DiagnosticsService } from '../src/services/diagnostics-service.ts';

export function diagnose(path, clock = Date.now) {
  const store = new SqliteStore(path, { readOnly: true });
  try {
    return new DiagnosticsService(store, new EventLedger(store, clock), clock).inspect();
  } finally {
    store.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const path = process.argv[2]
      ? resolve(process.argv[2])
      : fileURLToPath(new URL('../data/faultline.sqlite', import.meta.url));
    const report = diagnose(path);
    if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(
        `Faultline doctor: ${report.verdict.toUpperCase()} / ${report.counts.jobs} jobs / ${report.counts.events} events`,
      );
      for (const check of report.checks)
        console.log(
          `${check.status.toUpperCase().padEnd(4)}  ${check.label}  ${JSON.stringify(check.evidence)}`,
        );
      console.log(report.notice);
    }
    if (report.verdict === 'fail') process.exitCode = 1;
  } catch (error) {
    console.error(`Doctor could not inspect the existing database: ${error.message}`);
    process.exitCode = 1;
  }
}
