import type { ClaimedJob } from './domain/types.ts';
import { errorMessage } from './validation.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { Queue, LEASE_MS } from './queue.ts';
import { execute } from './handlers.ts';

const [database, slotText] = process.argv.slice(2);
if (!database || !slotText) throw new Error('Worker requires database path and slot.');
const slot = Number(slotText);
const id = `worker-${slot}-${randomUUID().slice(0, 8)}`;
const queue = new Queue(database);
queue.registerWorker(id, slot, process.pid);
await new Promise<void>((resolve, reject) =>
  process.send
    ? process.send({ type: 'ready', id }, undefined, {}, (error: Error | null) =>
        error ? reject(error) : resolve(),
      )
    : resolve(),
);
let current: (ClaimedJob & { stalled?: boolean; lostLease?: boolean }) | null = null;
let stopping = false;
const stop = () => {
  stopping = true;
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
// Parent death closes IPC: finish current work, then stop claiming new jobs.
process.on('disconnect', stop);

const heartbeat = setInterval(() => {
  try {
    const paused = queue.metadata('paused') === 'true';
    queue.heartbeat(id, current ? 'busy' : paused ? 'paused' : 'idle', current?.id ?? null);
    if (current && !current.stalled && !queue.renew(current.id, id, current.token))
      current.lostLease = true;
  } catch (error) {
    console.error(
      JSON.stringify({ worker: id, code: 'HEARTBEAT_FAILED', message: errorMessage(error) }),
    );
  }
}, 400);

try {
  while (!stopping) {
    try {
      current = queue.claim(id);
      if (!current) {
        await sleep(100);
        continue;
      }
      const definition = current.definition;
      if (definition.fault.crashOnce && current.generation === 0 && current.attempt === 1) {
        // An actual OS process dies; no timer rewrites the job into success.
        const { id: jobId, token } = current;
        queue.transaction(() =>
          queue.event('worker.crash.requested', jobId, {
            workerId: id,
            token,
            signal: 'SIGKILL',
          }),
        );
        process.kill(process.pid, 'SIGKILL');
      }
      if (definition.fault.stallOnce && current.generation === 0 && current.attempt === 1) {
        // A real process remains alive but deliberately stops renewing its job.
        // Its late commit must reach the database and be rejected by fencing.
        current.stalled = true;
        await sleep(LEASE_MS + 1800);
      }
      await sleep(definition.delayMs);
      if (current.lostLease) continue;
      if (current.attempt <= definition.fault.failFirst) {
        queue.fail(current.id, id, current.token, {
          code: 'INJECTED_FAILURE',
          message: '可控的瞬时失败，用于验证重试策略。',
        });
      } else {
        let result;
        try {
          result = execute(current.kind, definition.text);
        } catch (error) {
          queue.fail(current.id, id, current.token, error);
          continue;
        }
        // Persistence errors are infrastructure failures. Leave the lease for
        // expiry/recovery instead of recording a fictitious handler failure.
        queue.complete(current.id, id, current.token, result);
      }
    } catch (error) {
      console.error(
        JSON.stringify({ worker: id, code: 'WORKER_LOOP_FAILED', message: errorMessage(error) }),
      );
      await sleep(500);
    } finally {
      current = null;
    }
  }
} finally {
  clearInterval(heartbeat);
  try {
    queue.stopWorker(id);
  } catch (error) {
    console.error(
      JSON.stringify({ worker: id, code: 'WORKER_STOP_FAILED', message: errorMessage(error) }),
    );
  } finally {
    queue.close();
    // Explicitly release IPC even if shutdown metadata could not be written.
    if (process.connected) process.disconnect();
  }
}
