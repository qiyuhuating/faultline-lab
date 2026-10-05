import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server.mjs';

const playwright = process.env.FAULTLINE_PLAYWRIGHT ? await import(process.env.FAULTLINE_PLAYWRIGHT) : await import('playwright');
const type = process.env.FAULTLINE_BROWSER ?? 'chromium';
const directory = mkdtempSync(join(tmpdir(), 'faultline-network-'));
const instance = await startServer({ port: 0, database: join(directory, 'queue.sqlite'), workers: 0, quiet: true });
let stalled = 'bootstrap';
let writes = 0;
let lookups = 0;
const traffic = [];
const proxy = createServer((incoming, response) => {
  const path = new URL(incoming.url, instance.url).pathname;
  traffic.push({ at: Math.round(performance.now()), method: incoming.method, path, stalled });
  if (incoming.method === 'GET' && path.startsWith('/api/requests/')) lookups++;
  if (incoming.method === 'GET' && path === `/api/${stalled}`) {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{');
    return;
  }
  const upstream = request(new URL(incoming.url, instance.url), {
    method: incoming.method,
    headers: { ...incoming.headers, host: new URL(instance.url).host, ...(incoming.headers.origin ? { origin: instance.url } : {}) },
  }, result => {
    traffic.push({ at: Math.round(performance.now()), path, status: result.statusCode, event: 'upstream response' });
    result.on('end', () => traffic.push({ at: Math.round(performance.now()), path, event: 'upstream body complete' }));
    if (stalled === 'write' && incoming.method === 'POST' && path === '/api/jobs') {
      writes++;
      stalled = '';
      result.resume();
      response.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
      response.write('{');
    } else {
      response.writeHead(result.statusCode, result.headers);
      result.pipe(response);
    }
  });
  upstream.on('error', () => response.destroy());
  response.on('close', () => upstream.destroy());
  incoming.pipe(upstream);
});
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
let browser, page;
const checks = [];
const exceptions = [];
// Allow the existing 20s read backoff, one 8s request and the 3s polling interval.
const recoveryTimeout = 35000;
try {
  browser = await playwright[type].launch({ headless: true });
  page = await browser.newPage();
  page.on('pageerror', error => exceptions.push(error.message));
  page.on('requestfailed', request => traffic.push({ at: Math.round(performance.now()), failedPath: new URL(request.url()).pathname, error: request.failure()?.errorText }));
  await page.goto(`http://127.0.0.1:${proxy.address().port}`);
  await page.waitForFunction(() => document.querySelector('#error-banner').textContent.includes('连接中断'), null, { timeout: 12000 });
  stalled = '';
  await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('LIVE') && !document.querySelector('#error-banner').textContent, null, { timeout: recoveryTimeout });
  checks.push('partial bootstrap body times out and reconnects without reload');

  stalled = 'snapshot';
  await page.waitForFunction(() => document.querySelector('#error-banner').textContent.includes('连接中断'), null, { timeout: 14000 });
  stalled = '';
  await page.waitForFunction(() => document.querySelector('#connection').textContent.includes('LIVE') && !document.querySelector('#error-banner').textContent, null, { timeout: recoveryTimeout });
  checks.push('partial snapshot body releases the read lock and recovers');

  stalled = 'write';
  await page.locator('#create-button').click();
  await page.locator('[name="label"]').fill('network delayed write');
  await page.locator('#submit-button').click();
  await page.waitForFunction(() => !document.querySelector('#submit-button').disabled, null, { timeout: 12000 });
  assert.equal(writes, 1, 'An unknown write outcome never causes an automatic second POST.');
  assert.equal(lookups, 1, 'The committed write is resolved by one durable request lookup.');
  assert.equal(instance.queue.db.prepare('SELECT COUNT(*) n FROM jobs WHERE label=?').get('network delayed write').n, 1);
  assert.equal(await page.locator('#form-error').textContent(), '');
  assert.equal(await page.locator('#create-dialog').evaluate(dialog => dialog.open), false);
  checks.push('partial committed POST is confirmed by request key without a duplicate write');
  assert.deepEqual(exceptions, []);
  const artifacts = resolve('test-results', type);
  mkdirSync(artifacts, { recursive: true });
  const report = { browser: type, checks, passed: checks.length };
  writeFileSync(join(artifacts, 'network-result.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(artifacts, 'network-traffic.json'), JSON.stringify({ browser: type, status: 'pass', elapsedMs: Math.round(performance.now()), traffic }, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const artifacts = resolve('test-results', type);
  mkdirSync(artifacts, { recursive: true });
  const observed = await page?.evaluate(() => ({ connection: document.querySelector('#connection')?.textContent, banner: document.querySelector('#error-banner')?.textContent, hidden: document.hidden })).catch(() => null);
  writeFileSync(join(artifacts, 'network-failure.json'), JSON.stringify({ browser: type, error: error.message, checks, stalled, writes, lookups, exceptions, observed, traffic }, null, 2) + '\n');
  throw error;
} finally {
  await browser?.close();
  proxy.closeAllConnections();
  await new Promise(resolve => proxy.close(resolve));
  await instance.close();
  rmSync(directory, { recursive: true, force: true });
}
