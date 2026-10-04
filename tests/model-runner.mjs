import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runModel, COMMANDS } from './model/runner.mjs';
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const match = /^--(seed|seeds|steps|output)=(.+)$/.exec(arg);
    if (!match)
      throw new Error(
        'Usage: node tests/model-runner.mjs --seed=1 --seeds=128 --steps=256 --output=test-results/model/report.json',
      );
    return [match[1], match[2]];
  }),
);
const seed = Number(args.seed ?? 1),
  seeds = Number(args.seeds ?? 32),
  steps = Number(args.steps ?? 128);
if (!Number.isSafeInteger(seeds) || seeds < 1 || seeds > 2048)
  throw new Error('seeds must be 1–2048');
const report = {
  format: 'faultline-model-campaign-v1',
  runtime: process.versions,
  seed,
  seeds,
  steps,
  status: 'running',
  runs: [],
  coverage: Object.fromEntries(COMMANDS.map((c) => [c, 0])),
};
try {
  for (let i = 0; i < seeds; i++) {
    const result = runModel({ seed: seed + i, steps });
    report.runs.push(result);
    for (const command of COMMANDS) report.coverage[command] += result.coverage[command];
  }
  report.status = 'pass';
  report.transitions = seeds * steps;
} catch (error) {
  report.status = 'fail';
  report.failure = error.reproduction ?? { message: error.message };
  process.exitCode = 1;
} finally {
  const path = resolve(args.output ?? 'test-results/model/report.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify(
      {
        status: report.status,
        completedSeeds: report.runs.length,
        transitions: report.transitions ?? report.runs.length * steps,
        coverage: report.coverage,
        report: path,
      },
      null,
      2,
    ),
  );
}
