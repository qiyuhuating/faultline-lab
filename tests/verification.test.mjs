import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { verifyLab } from '../tools/verify-lab.mjs';
test('invalid live-verification configuration does not start workers or create artifacts', async () => {
  const path = join(tmpdir(), 'faultline-invalid-' + process.pid);
  await assert.rejects(() => verifyLab({ workers: 1, output: path }), /2–8/);
  assert.equal(existsSync(path), false);
});
test(
  'a real experiment deadline retains a failed report and shuts down its server and workers',
  { timeout: 15000 },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'faultline-verification-timeout-'));
    try {
      await assert.rejects(
        () => verifyLab({ output: root, timeoutMs: 100, workers: 2, scenarios: ['crash'] }),
        (error) => /deadline/.test(error.message) && typeof error.reportPath === 'string',
      );
      const dirs = readdirSync(root);
      assert.equal(dirs.length, 1);
      const report = JSON.parse(readFileSync(join(root, dirs[0], 'report.json'), 'utf8'));
      assert.equal(report.status, 'fail');
      assert.equal(report.cleanupFailure, undefined);
      assert.match(report.failure.message, /deadline/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
