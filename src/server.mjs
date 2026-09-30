import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Queue, LEASE_MS } from './queue.mjs';
import { DomainError, insist, integer, object, key } from './validation.mjs';

const PUBLIC = new URL('../public/', import.meta.url);
const DEFAULT_DATABASE = fileURLToPath(new URL('../data/faultline.sqlite', import.meta.url));
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/proof.mjs', ['proof.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
]);

function headers(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'none'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader('Cache-Control', 'no-store');
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

async function readJSON(request) {
  insist(request.headers['content-type']?.split(';')[0].trim() === 'application/json', 'CONTENT_TYPE', '请使用 application/json。', 415);
  const buffer = await new Promise((resolveBody, reject) => {
    let size = 0;
    let rejected = false;
    const chunks = [];
    request.on('data', chunk => {
      if (rejected) return;
      size += chunk.length;
      if (size > 32768) {
        rejected = true;
        chunks.length = 0;
        reject(new DomainError('TOO_LARGE', '请求正文不能超过 32 KB。', 413));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => { if (!rejected) resolveBody(Buffer.concat(chunks)); });
    request.on('error', reject);
    request.on('aborted', () => reject(new DomainError('REQUEST_ABORTED', '请求正文未传输完整。')));
  });
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)); }
  catch { throw new DomainError('INVALID_JSON', 'JSON 格式不正确。'); }
}

function equalToken(value, expected) {
  if (typeof value !== 'string' || value.length !== expected.length) return false;
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

export async function startServer({ port = 8787, database = DEFAULT_DATABASE, workers = 3, quiet = false } = {}) {
  integer(port, 0, 65535, 'port');
  integer(workers, 0, 8, 'workers');
  const queue = new Queue(database);
  const token = randomBytes(32).toString('hex');
  const streams = new Set();
  const children = new Set();
  const restartTimers = new Set();
  let closing = false;
  let actualPort = port;

  const server = createServer(async (request, response) => {
    headers(response);
    try {
      const hosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);
      insist(hosts.has(request.headers.host), 'HOST_REJECTED', '只允许本机地址访问。', 403);
      const url = new URL(request.url, `http://127.0.0.1:${actualPort}`);
      const path = url.pathname;
      if (request.method === 'GET' && STATIC.has(path)) {
        const [file, mime] = STATIC.get(path);
        const content = readFileSync(new URL(file, PUBLIC));
        response.writeHead(200, { 'Content-Type': mime, 'Content-Length': content.length });
        response.end(content);
        return;
      }
      insist(path.startsWith('/api/'), 'NOT_FOUND', '资源不存在。', 404);
      if (request.method === 'GET') {
        if (path === '/api/bootstrap') {
          json(response, 200, { version: '1.0.0', controlToken: token, serverTime: Date.now(), leaseMs: LEASE_MS, workerCount: workers, mode: 'local-lab' });
        } else if (path === '/api/snapshot') {
          const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : Number.MAX_SAFE_INTEGER;
          const snapshot = queue.snapshot({ state: url.searchParams.get('state') ?? '', before });
          const workerStamp = snapshot.workers.reduce((sum, w) => sum + w.last_seen, 0);
          const etag = `"${snapshot.revision}-${workerStamp}-${url.search}"`;
          response.setHeader('ETag', etag);
          if (request.headers['if-none-match'] === etag) response.writeHead(304).end();
          else json(response, 200, snapshot);
        } else if (/^\/api\/requests\/[\w.:\-]{8,128}$/.test(path)) {
          json(response, 200, queue.requestStatus(path.split('/').at(-1)));
        } else if (/^\/api\/experiments\/[0-9a-f-]{36}$/.test(path)) {
          json(response, 200, queue.experimentReport(path.split('/').at(-1)));
        } else if (/^\/api\/jobs\/[0-9a-f-]{36}$/.test(path)) {
          json(response, 200, { job: queue.detail(path.split('/').at(-1)), serverTime: Date.now() });
        } else if (path === '/api/evidence') {
          response.setHeader('Content-Disposition', 'attachment; filename="faultline-evidence.json"');
          json(response, 200, queue.evidence());
        } else if (path === '/api/events') {
          insist(streams.size < 12, 'STREAM_CAPACITY', '实时连接已达上限。', 503);
          const provided = request.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
          let cursor = Number(provided);
          integer(cursor, 0, Number.MAX_SAFE_INTEGER, 'event cursor');
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
          response.write('retry: 1500\nevent: ready\ndata: {}\n\n');
          const stream = { response, timer: null };
          streams.add(stream);
          let heartbeatAt = Date.now();
          const flush = () => {
            try {
              const first = queue.db.prepare('SELECT MIN(seq) first FROM events').get().first;
              const head = Number(queue.metadata('event_seq'));
              if (cursor > head || (first !== null && cursor > 0 && cursor < first - 1)) {
                response.write(`event: reset\ndata: {"revision":${head}}\n\n`);
                cursor = head;
              }
              for (const event of queue.events({ after: cursor, limit: 100 })) {
                cursor = event.seq;
                if (!response.write(`id: ${event.seq}\nevent: change\ndata: ${JSON.stringify(event)}\n\n`)) {
                  response.end();
                  break;
                }
              }
              if (Date.now() - heartbeatAt > 15000) {
                response.write(': heartbeat\n\n');
                heartbeatAt = Date.now();
              }
            } catch { response.end(); }
          };
          stream.timer = setInterval(flush, 250);
          flush();
          response.on('close', () => { clearInterval(stream.timer); streams.delete(stream); });
        } else throw new DomainError('NOT_FOUND', '接口不存在。', 404);
        return;
      }
      insist(request.method === 'POST', 'METHOD_NOT_ALLOWED', '只支持 GET 和 POST。', 405);
      const origins = new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`]);
      insist(!request.headers.origin || origins.has(request.headers.origin), 'ORIGIN_REJECTED', '跨站写入已拒绝。', 403);
      insist(request.headers['sec-fetch-site'] !== 'cross-site', 'ORIGIN_REJECTED', '跨站写入已拒绝。', 403);
      insist(equalToken(request.headers['x-control-token'], token), 'CONTROL_TOKEN_REQUIRED', '控制令牌已失效，请刷新连接。', 403);
      const requestKey = key(request.headers['idempotency-key']);
      const body = await readJSON(request);
      if (path === '/api/jobs') json(response, 201, queue.submit(body, requestKey));
      else if (path === '/api/experiments') {
        object(body, ['scenario']);
        const result = queue.experiment(body.scenario, requestKey);
        if (body.scenario === 'response-loss' && !result.deduplicated) {
          queue.transaction(() => queue.event('response.dropped', result.jobIds[0], { experimentId: result.experimentId, reason: 'injected-after-commit' }));
          response.destroy();
        } else json(response, 201, result);
      } else if (/^\/api\/jobs\/[0-9a-f-]{36}\/transitions$/.test(path)) {
        object(body, ['action', 'expectedRevision', 'clearFaults']);
        json(response, 200, queue.transition(path.split('/')[3], body.action, body.expectedRevision, requestKey, { clearFaults: body.clearFaults ?? false }));
      } else if (path === '/api/control') {
        object(body, ['paused']);
        json(response, 200, queue.setPaused(body.paused, requestKey));
      } else throw new DomainError('NOT_FOUND', '接口不存在。', 404);
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.end(); return; }
      const known = error instanceof DomainError;
      if (!known && !quiet) console.error(JSON.stringify({ code: 'SERVER_ERROR', message: error.message }));
      json(response, known ? error.status : 500, { error: { code: known ? error.code : 'SERVER_ERROR', message: known ? error.message : '服务未能完成操作，请读取状态后再试。' } });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 32;
  await new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveStart);
  });
  actualPort = server.address().port;

  function spawnWorker(slot) {
    const child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [database, String(slot)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] });
    const record = { child, id: null, slot };
    children.add(record);
    child.on('message', message => { if (message.type === 'ready') record.id = message.id; });
    child.stderr.on('data', chunk => { if (!quiet) process.stderr.write(chunk); });
    child.on('exit', (code, signal) => {
      children.delete(record);
      if (record.id) queue.stopWorker(record.id, signal ? `signal:${signal}` : `exit:${code}`);
      if (!closing) {
        const timer = setTimeout(() => { restartTimers.delete(timer); if (!closing) spawnWorker(slot); }, 500);
        restartTimers.add(timer);
      }
    });
    return record;
  }
  for (let slot = 1; slot <= workers; slot++) spawnWorker(slot);
  const sweep = setInterval(() => { try { queue.recover(); } catch (error) { if (!quiet) console.error(error.message); } }, 200);
  const retention = setInterval(() => { try { queue.prune(); } catch (error) { if (!quiet) console.error(error.message); } }, 600000);
  queue.prune();

  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(sweep);
    clearInterval(retention);
    for (const timer of restartTimers) clearTimeout(timer);
    for (const stream of streams) { clearInterval(stream.timer); stream.response.end(); }
    const exits = [...children].map(({ child }) => new Promise(resolveExit => { child.once('exit', resolveExit); child.kill('SIGTERM'); }));
    const graceful = await Promise.race([Promise.all(exits).then(() => true), sleep(9000, undefined, { ref: false }).then(() => false)]);
    if (!graceful) {
      for (const { child } of children) child.kill('SIGKILL');
      await Promise.all(exits);
    }
    await new Promise(resolveClose => { server.close(resolveClose); server.closeIdleConnections(); });
    queue.close();
  }
  return { server, queue, token, url: `http://127.0.0.1:${actualPort}`, close, children };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {};
  for (const argument of process.argv.slice(2)) {
    const match = /^--(port|db|workers)=(.+)$/.exec(argument);
    if (!match) throw new Error('Usage: node src/server.mjs [--port=8787] [--db=data/faultline.sqlite] [--workers=3]');
    if (match[1] === 'db') options.database = resolve(match[2]);
    else options[match[1]] = Number(match[2]);
  }
  insist((options.workers ?? 3) >= 1, 'VALIDATION', '至少需要一个 Worker。');
  const instance = await startServer(options);
  console.log(`Faultline 1.0.0 · ${instance.url} · ${options.workers ?? 3} workers · local lab`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await instance.close();
  });
}
