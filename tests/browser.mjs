import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from '../src/server.mjs';

const playwright = process.env.FAULTLINE_PLAYWRIGHT ? await import(process.env.FAULTLINE_PLAYWRIGHT) : await import('playwright');
const type = process.env.FAULTLINE_BROWSER ?? 'chromium';
if (!['chromium', 'firefox', 'webkit'].includes(type)) throw new Error('Unsupported browser.');
const directory = mkdtempSync(join(tmpdir(), 'faultline-browser-'));
const artifacts = resolve('test-results', type);
mkdirSync(artifacts, { recursive: true });
const instance = await startServer({ port: 0, database: join(directory, 'queue.sqlite'), workers: 3, quiet: true });
let browser;
const results = [];
try {
  browser = await playwright[type].launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const exceptions = [];
  const securityErrors = [];
  page.on('pageerror', error => exceptions.push(error.message));
  page.on('console', message => { if (/Content Security Policy|Refused to/.test(message.text())) securityErrors.push(message.text()); });
  await page.goto(instance.url);
  await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('LIVE'));
  assert.match(await page.title(), /Faultline/);
  results.push('connected dashboard');

  await page.locator('[data-scenario="duplicate"]').click();
  await page.waitForFunction(() => document.querySelector('#total-count').textContent === '1');
  await page.waitForFunction(() => document.querySelector('#metric-done').textContent === '1');
  assert.equal(await page.locator('#job-rows tr').count(), 1);
  assert.equal(await page.locator('#metric-dedupe').textContent(), '2');
  results.push('duplicate intent renders one job');

  await page.locator('[data-scenario="dead"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.state-badge')].some(node => node.textContent === '死信'), null, { timeout: 15000 });
  const dead = page.locator('#job-rows tr').filter({ hasText: 'Retry exhausted' });
  await dead.locator('button').click();
  await page.locator('#detail-dialog').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '清除故障并重放 →' }).click();
  await page.waitForFunction(() => document.querySelector('#detail-dialog .state-badge')?.textContent === '已成功', null, { timeout: 15000 });
  assert.match(await page.locator('#detail-content').textContent(), /G1/);
  results.push('dead letter can be replayed in the UI');
  await page.locator('[data-close="detail-dialog"]').click();

  await page.locator('#create-button').click();
  const label = '<img src=x onerror="window.__xss=true">';
  await page.locator('[name="label"]').fill(label);
  await page.locator('[name="text"]').fill('1,2,3');
  await page.locator('#submit-button').click();
  await page.waitForFunction(expected => [...document.querySelectorAll('.job-name')].some(node => node.textContent === expected), label);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.locator('#job-rows img').count(), 0);
  results.push('untrusted label remains text');

  const original = await page.locator('#total-count').textContent();
  await page.locator('[data-state="succeeded"]').click();
  await page.locator('[data-state=""]').click();
  assert.equal(await page.locator('#total-count').textContent(), original);
  results.push('filter switching retains the correct snapshot');

  await page.locator('[data-scenario="fence"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.report-row')].some(row => row.textContent.includes('Zombie worker') && row.textContent.includes('PASS')), null, { timeout: 20000 });
  await page.locator('.report-row').filter({ hasText: 'Zombie worker' }).click();
  assert.match(await page.locator('#report-content').textContent(), /旧 Worker 的真实写入被拒绝/);
  assert.match(await page.locator('#report-content').textContent(), /commit.rejected/);
  await page.locator('[data-close="report-dialog"]').click();
  results.push('real stale worker rejection has a passing causal report');

  const beforeLostResponse = Number(await page.locator('#total-count').textContent());
  await page.locator('[data-scenario="response-loss"]').click();
  await page.waitForFunction(expected => Number(document.querySelector('#total-count').textContent) === expected, beforeLostResponse + 1);
  await page.waitForFunction(() => [...document.querySelectorAll('.report-row')].some(row => row.textContent.includes('Lost response') && row.textContent.includes('PASS')));
  assert.equal(Number(await page.locator('#total-count').textContent()), beforeLostResponse + 1);
  results.push('write succeeds with a deliberately lost response; durable lookup confirms one job');

  await page.locator('#create-button').click();
  await page.locator('[name="label"]').fill('survives full reload');
  await page.locator('[name="text"]').fill('draft remains here');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('LIVE'));
  await page.locator('#create-button').click();
  assert.equal(await page.locator('[name="label"]').inputValue(), 'survives full reload');
  assert.equal(await page.locator('[name="text"]').inputValue(), 'draft remains here');
  await page.locator('[data-close="create-dialog"]').first().click();
  results.push('draft survives a full reload');

  const ledgerCount = await page.locator('#job-rows tr').count();
  await page.route('**/api/snapshot*', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"jobs":null}' }));
  await page.locator('[data-state="succeeded"]').click();
  await page.waitForFunction(() => !document.querySelector('#error-banner').hidden);
  assert.equal(await page.locator('#job-rows tr').count(), ledgerCount);
  await page.unroute('**/api/snapshot*');
  await page.locator('[data-state=""]').click();
  await page.waitForFunction(() => document.querySelector('#error-banner').hidden);
  results.push('malformed snapshot preserves the last valid ledger and recovers');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-button').click();
  const download = await downloadPromise;
  await download.saveAs(join(artifacts, 'evidence.json'));
  results.push('evidence downloads');

  await page.screenshot({ path: join(artifacts, 'desktop.png'), fullPage: true, caret: 'initial' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(artifacts, 'mobile.png'), fullPage: true, caret: 'initial' });
  results.push('mobile layout has no page overflow');

  const context = page.context();
  await page.locator('#create-button').click();
  await page.locator('[name="label"]').fill('draft survives');
  await context.setOffline(true);
  await page.locator('#submit-button').click();
  await page.waitForFunction(() => document.querySelector('#form-error').textContent.includes('结果未确认'));
  assert.equal(await page.locator('[name="label"]').inputValue(), 'draft survives');
  await context.setOffline(false);
  await sleep(800);
  await page.locator('#submit-button').click();
  await page.waitForFunction(() => !document.querySelector('#create-dialog').open);
  results.push('offline write keeps draft and recovers');

  assert.deepEqual(exceptions, []);
  assert.deepEqual(securityErrors, []);
  results.push('no JavaScript exceptions or CSP violations');
  console.log(JSON.stringify({ browser: type, checks: results, passed: results.length }, null, 2));
  writeFileSync(join(artifacts, 'browser-result.json'), `${JSON.stringify({ browser: type, checks: results, passed: results.length }, null, 2)}\n`);
} finally {
  await browser?.close();
  await instance.close();
  rmSync(directory, { recursive: true, force: true });
}
