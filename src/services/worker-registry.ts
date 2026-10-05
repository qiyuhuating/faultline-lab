import type { SqliteStore } from '../storage/sqlite-store.ts';
import type { EventLedger } from './event-ledger.ts';
import type { Clock, WorkerRow } from '../domain/types.ts';
export class WorkerRegistry {
  readonly store: SqliteStore;
  readonly ledger: EventLedger;
  readonly clock: Clock;
  constructor(store: SqliteStore, ledger: EventLedger, clock: Clock) {
    this.store = store;
    this.ledger = ledger;
    this.clock = clock;
  }
  register(id: string, slot: number, pid: number) {
    this.store.transaction(() => {
      const now = this.clock();
      this.store.run(
        'INSERT INTO workers VALUES (?, ?, ?, ?, ?, ?, ?)',
        id,
        slot,
        pid,
        'idle',
        null,
        now,
        now,
      );
      this.ledger.append('worker.started', null, { workerId: id, slot, pid }, now);
    });
  }

  heartbeat(id: string, phase: 'idle' | 'busy' | 'paused', jobId: string | null = null) {
    this.store.run(
      "UPDATE workers SET last_seen=?, phase=?, job_id=? WHERE id=? AND phase!='stopped'",
      this.clock(),
      phase,
      jobId,
      id,
    );
  }

  stop(id: string, reason = 'shutdown') {
    this.store.transaction(() => {
      const existing = this.store.one<WorkerRow>('SELECT * FROM workers WHERE id=?', id);
      if (!existing || existing.phase === 'stopped') return;
      this.store.run(
        "UPDATE workers SET phase='stopped', last_seen=? WHERE id=?",
        this.clock(),
        id,
      );
      this.ledger.append('worker.stopped', existing.job_id, {
        workerId: id,
        reason,
        platform: process.platform,
      });
      // A stopped worker's job is intentionally recovered by lease expiry.
    });
  }
}
