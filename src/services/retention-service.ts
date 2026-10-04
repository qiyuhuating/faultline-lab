import type { SqliteStore } from '../storage/sqlite-store.ts';
import type { Clock, RetentionOptions } from '../domain/types.ts';
export class RetentionService {
  readonly store: SqliteStore;
  readonly clock: Clock;
  readonly invalidateReports: () => void;
  constructor(store: SqliteStore, clock: Clock, invalidateReports: () => void) {
    this.store = store;
    this.clock = clock;
    this.invalidateReports = invalidateReports;
  }
  prune({ days = 30, maxEvents = 50000 }: RetentionOptions = {}) {
    const result = this.store.transaction(() => {
      const cutoff = this.clock() - days * 86400000;
      const removed = this.store.run(
        "DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE state IN ('succeeded','dead','cancelled') AND completed_at<? LIMIT 500)",
        cutoff,
      ).changes;
      this.store.run('DELETE FROM requests WHERE created_at<?', cutoff);
      this.store.run(
        'DELETE FROM experiments WHERE created_at<? OR EXISTS (SELECT 1 FROM json_each(experiments.job_ids) j WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE id=j.value))',
        cutoff,
      );
      this.store.run("DELETE FROM workers WHERE phase='stopped' AND last_seen<?", cutoff);
      const head = Number(this.store.metadata('event_seq'));
      const candidates = this.store.all<{ seq: number; at: number; hash: string }>(
        'SELECT seq, at, hash FROM events ORDER BY seq LIMIT 5000',
      );
      let last: { seq: number; at: number; hash: string } | null = null;
      for (const row of candidates) {
        if (row.at >= cutoff && row.seq > head - maxEvents) break;
        last = row;
      }
      let removedEvents: number | bigint = 0;
      if (last) {
        removedEvents = this.store.run('DELETE FROM events WHERE seq<=?', last.seq).changes;
        this.store.run("UPDATE meta SET value=? WHERE key='event_anchor'", last.hash);
        this.store.run(
          "INSERT INTO meta(key,value) VALUES ('event_anchor_seq',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          String(last.seq),
        );
      }
      return { removedJobs: removed, removedEvents };
    });
    this.invalidateReports();
    return result;
  }
}
