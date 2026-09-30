import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Queue } from './queue.mjs';
import { execute } from './handlers.mjs';

const [database, slotText] = process.argv.slice(2);
if (!database || !slotText) throw new Error('Worker requires database path and slot.');
const slot = Number(slotText);
const id = `worker-${slot}-${randomUUID().slice(0, 8)}`;
const queue = new Queue(database);
queue.registerWorker(id, slot, process.pid);
await new Promise(resolve => process.send ? process.send({ type: 'ready', id }, resolve) : resolve());
let current = null;
let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
// Parent death closes IPC: finish current work, then stop claiming new jobs.
process.on('disconnect', stop);

const heartbeat = setInterval(() => {
  try {
    const paused = queue.metadata('paused') === 'true';
    queue.heartbeat(id, current ? 'busy' : paused ? 'paused' : 'idle', current?.id ?? null);
    if (current && !queue.renew(current.id, id, current.token)) current.lostLease = true;
  } catch (error) {
    console.error(JSON.stringify({ worker: id, code: 'HEARTBEAT_FAILED', message: error.message }));
  }
}, 400);

try {
  while (!stopping) {
    try {
      current = queue.claim(id);
      if (!current) { await sleep(100); continue; }
      const definition = current.definition;
      if (definition.fault.crashOnce && current.generation === 0 && current.attempt === 1) {
        // An actual OS process dies; no timer rewrites the job into success.
        process.kill(process.pid, 'SIGKILL');
      }
      await sleep(definition.delayMs);
      if (current.lostLease) continue;
      if (current.attempt <= definition.fault.failFirst) {
        queue.fail(current.id, id, current.token, { code: 'INJECTED_FAILURE', message: '可控的瞬时失败，用于验证重试策略。' });
      } else {
        try { queue.complete(current.id, id, current.token, execute(current.kind, definition.text)); }
        catch (error) { queue.fail(current.id, id, current.token, error); }
      }
    } catch (error) {
      console.error(JSON.stringify({ worker: id, code: 'WORKER_LOOP_FAILED', message: error.message }));
      await sleep(500);
    } finally {
      current = null;
    }
  }
} finally {
  clearInterval(heartbeat);
  queue.stopWorker(id);
  queue.close();
}
