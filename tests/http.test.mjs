import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { startServer } from '../src/server.mjs';

let instance;
let directory;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'faultline-http-'));
  instance = await startServer({ port: 0, database: join(directory, 'queue.sqlite'), workers: 0, quiet: true });
});
after(async () => { await instance.close(); rmSync(directory, { recursive: true, force: true }); });
const headers = () => ({ 'Content-Type': 'application/json', 'X-Control-Token': instance.token, 'Idempotency-Key': randomUUID() });
const post = (path, body, extra = {}) => fetch(`${instance.url}${path}`, { method: 'POST', headers: { ...headers(), ...extra }, body: JSON.stringify(body) });

test('static UI, bootstrap and CSP are served', async () => {
  const response = await fetch(instance.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /style-src-attr 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await response.text(), /Watch it recover/);
  const boot = await (await fetch(`${instance.url}/api/bootstrap`)).json();
  assert.equal(boot.mode, 'local-lab');
  assert.equal(boot.controlToken.length, 64);
});

test('write without control token is rejected', async () => {
  const response = await post('/api/jobs', { label: 'x' }, { 'X-Control-Token': '' });
  assert.equal(response.status, 403);
});

test('non-ASCII control token is rejected without a server exception', async () => {
  const response = await post('/api/jobs', { label: 'x' }, { 'X-Control-Token': 'é'.repeat(64) });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'CONTROL_TOKEN_REQUIRED');
});

test('cross-site write is rejected even with a token', async () => {
  const response = await post('/api/jobs', { label: 'x' }, { Origin: 'https://evil.example' });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'ORIGIN_REJECTED');
});

test('DNS-rebinding Host is rejected', async () => {
  // Fetch rewrites Host. Use the raw HTTP client to exercise the actual header.
  const status = await new Promise((resolve, reject) => {
    get(`${instance.url}/api/bootstrap`, { headers: { Host: 'evil.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(status, 403);
});

test('missing idempotency key is rejected', async () => {
  const response = await post('/api/jobs', { label: 'x' }, { 'Idempotency-Key': '' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'IDEMPOTENCY_REQUIRED');
});

test('malformed JSON and unsupported body fields fail explicitly', async () => {
  const response = await fetch(`${instance.url}/api/jobs`, { method: 'POST', headers: headers(), body: '{nope' });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_JSON');
  assert.equal((await post('/api/jobs', { shell: 'rm -rf /' })).status, 400);
});

test('body size limit returns 413 without creating a task', async () => {
  const before = instance.queue.snapshot().jobs.length;
  const response = await post('/api/jobs', { text: 'x'.repeat(40000) });
  assert.equal(response.status, 413);
  assert.equal(instance.queue.snapshot().jobs.length, before);
});

test('three parallel HTTP submissions with same key create one task', async () => {
  const intent = randomUUID();
  const responses = await Promise.all(Array.from({ length: 3 }, () => post('/api/jobs', { label: 'parallel HTTP', text: 'proof' }, { 'Idempotency-Key': intent })));
  assert.ok(responses.every(r => r.status === 201));
  const results = await Promise.all(responses.map(r => r.json()));
  assert.equal(new Set(results.map(r => r.jobId)).size, 1);
  assert.equal(results.filter(r => r.deduplicated).length, 2);
  const changed = await post('/api/jobs', { label: 'changed' }, { 'Idempotency-Key': intent });
  assert.equal(changed.status, 409);
});

test('stale revision receives 409 and original data survives', async () => {
  const create = await (await post('/api/jobs', { label: 'race' })).json();
  const route = `/api/jobs/${create.jobId}/transitions`;
  assert.equal((await post(route, { action: 'cancel', expectedRevision: 1 })).status, 200);
  const stale = await post(route, { action: 'cancel', expectedRevision: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'REVISION_CONFLICT');
});

test('snapshot supports conditional reads and validates pagination', async () => {
  const response = await fetch(`${instance.url}/api/snapshot`);
  const etag = response.headers.get('etag');
  assert.ok(etag);
  const repeated = await fetch(`${instance.url}/api/snapshot`, { headers: { 'If-None-Match': etag } });
  assert.equal(repeated.status, 304);
  assert.equal((await fetch(`${instance.url}/api/snapshot?before=NaN`)).status, 400);
  assert.equal((await fetch(`${instance.url}/api/snapshot?state=unknown`)).status, 400);
});

test('SSE resumes from a persisted cursor', async () => {
  const head = Number(instance.queue.metadata('event_seq'));
  const controller = new AbortController();
  const response = await fetch(`${instance.url}/api/events?after=${head}`, { signal: controller.signal });
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  let stream = new TextDecoder().decode((await reader.read()).value);
  await post('/api/jobs', { label: 'SSE proof' });
  while (!stream.includes('event: change')) stream += new TextDecoder().decode((await reader.read()).value);
  assert.match(stream, /job.created/);
  assert.ok(stream.includes(`id: ${head + 1}`));
  controller.abort();
});

test('evidence export contains a valid retained event chain', async () => {
  const response = await fetch(`${instance.url}/api/evidence`);
  assert.match(response.headers.get('content-disposition'), /attachment/);
  const evidence = await response.json();
  assert.equal(evidence.integrity.valid, true);
  assert.ok(evidence.integrity.count > 0);
});
