import { createServer } from 'node:http';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const playwright = process.env.FAULTLINE_PLAYWRIGHT ? await import(process.env.FAULTLINE_PLAYWRIGHT) : await import('playwright');
const type = process.env.FAULTLINE_BROWSER ?? 'chromium';
const files = new Map([['/', ['index.html', 'text/html']], ['/styles.css', ['styles.css', 'text/css']], ['/player.mjs', ['player.mjs', 'text/javascript']], ['/proof.mjs', ['proof.mjs', 'text/javascript']], ['/evidence.mjs', ['evidence.mjs', 'text/javascript']], ['/traces.json', ['traces.json', 'application/json']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]]);
const server = createServer((req, res) => {
  const file = files.get(new URL(req.url, 'http://localhost').pathname);
  if (!file) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` });
  res.end(readFileSync(new URL(`../showcase/${file[0]}`, import.meta.url)));
});
await new Promise(resolveStart => server.listen(0, '127.0.0.1', resolveStart));
const url = `http://127.0.0.1:${server.address().port}`;
const artifacts = resolve('test-results', type);
mkdirSync(artifacts, { recursive: true });
let browser;
const checks = [], errors = [], security = [];
try {
  browser = await playwright[type].launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (/Content Security Policy|Refused to/.test(m.text())) security.push(m.text()); });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('#chain-status').textContent.includes('VERIFIED'));
  assert.equal(await page.locator('.scenario').count(), 6);
  checks.push('six real traces load and their event chain is independently verified');
  for (const scenario of ['crash', 'fence', 'retry', 'duplicate', 'dead', 'response-loss']) {
    await page.locator(`[data-scenario="${scenario}"]`).click();
    assert.equal(await page.locator('#final-verdict').textContent(), 'FINAL PASS');
    await page.locator('.event-row').last().click();
    assert.equal(await page.locator('#frame-receipts').textContent(), scenario === 'dead' ? '0' : '1');
    if (scenario === 'fence') assert.match(await page.locator('#frame-state').textContent(), /REJECTED/);
  }
  checks.push('every final frame matches actual receipts; stale commit is rejected');
  await page.locator('[data-scenario="crash"]').click();
  const secondEventSeq = await page.locator('.event-row').nth(1).getAttribute('data-seq');
  await page.locator('.event-row').nth(1).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#scrub').inputValue(), '1');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.seq), secondEventSeq);
  await page.keyboard.press('Tab');
  const thirdEventSeq = await page.locator('.event-row').nth(2).getAttribute('data-seq');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.seq), thirdEventSeq);
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#scrub').inputValue(), '2');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.seq), thirdEventSeq);
  checks.push('Enter and Space preserve the event focus for consecutive keyboard frame selection');
  await page.locator('#reset-button').click();
  await page.locator('#play-button').click();
  await page.waitForFunction(() => Number(document.querySelector('#scrub').value) > 0);
  await page.locator('#play-button').click();
  const paused = await page.locator('#scrub').inputValue();
  await page.waitForTimeout(1100);
  assert.equal(await page.locator('#scrub').inputValue(), paused);
  checks.push('playback advances actual event frames and pause is stable');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  checks.push('mobile player has no page overflow');
  const altered = JSON.parse(readFileSync(new URL('../showcase/traces.json', import.meta.url), 'utf8'));
  altered.evidence.events[0].data.label = 'tampered';
  await page.route('**/traces.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(altered) }));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#chain-status').textContent.includes('FAILED'));
  assert.equal(await page.locator('#play-button').isEnabled(), false);
  checks.push('modified evidence fails closed and disables playback');
  await page.unroute('**/traces.json');
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#chain-status').textContent.includes('VERIFIED'));
  assert.deepEqual(errors, []);
  assert.deepEqual(security, []);
  checks.push('no application exceptions or CSP violations');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.event-row').last().click();
  await page.screenshot({ path: join(artifacts, 'showcase-desktop.png'), fullPage: true, caret: 'initial' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, 'showcase-mobile.png'), fullPage: true, caret: 'initial' });
  assert.equal(security.length, type === 'webkit' ? 2 : 0, 'Only the known WebKit screenshot synchronization styles emit CSP diagnostics.');
  writeFileSync(join(artifacts, 'showcase-result.json'), `${JSON.stringify({ browser: type, checks, passed: checks.length, screenshotHarnessCSPDiagnostics: security.length }, null, 2)}\n`);
  console.log(JSON.stringify({ browser: type, showcaseChecks: checks, passed: checks.length }, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
