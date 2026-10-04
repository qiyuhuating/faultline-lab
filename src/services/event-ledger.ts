import type { SqliteStore } from '../storage/sqlite-store.ts';
import type { Clock, Event, EventRow, EventsQuery, JsonObject } from '../domain/types.ts';
import { canonical, digest, jsonObject, parseJSON } from '../validation.ts';

export class EventLedger {
  readonly store: SqliteStore;
  readonly clock: Clock;
  constructor(store: SqliteStore, clock: Clock) {
    this.store = store;
    this.clock = clock;
  }
  append(type: string, jobId: string | null, data: JsonObject, now = this.clock()) {
    const seq = Number(this.store.metadata('event_seq')) + 1;
    const last = this.store.one<{ hash: string }>(
      'SELECT hash FROM events ORDER BY seq DESC LIMIT 1',
    );
    const previousHash = last?.hash ?? this.store.metadata('event_anchor')!;
    const encoded = canonical(data);
    const hash = digest(
      canonical({ seq, jobId, type, at: now, data: parseJSON(encoded), previousHash }),
    );
    this.store.run(
      'INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)',
      seq,
      jobId,
      type,
      now,
      encoded,
      previousHash,
      hash,
    );
    this.store.run("UPDATE meta SET value=? WHERE key='event_seq'", String(seq));
    return seq;
  }

  events({ after = 0, jobId = null, limit = 100, newest = false }: EventsQuery = {}): Event[] {
    let rows: EventRow[];
    if (jobId)
      rows = this.store
        .all<EventRow>(
          'SELECT * FROM events WHERE job_id=? ORDER BY seq DESC LIMIT ?',
          jobId,
          limit,
        )
        .reverse();
    else if (newest)
      rows = this.store
        .all<EventRow>('SELECT * FROM events ORDER BY seq DESC LIMIT ?', limit)
        .reverse();
    else
      rows = this.store.all<EventRow>(
        'SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?',
        after,
        limit,
      );
    return rows.map((row) => ({
      seq: row.seq,
      jobId: row.job_id,
      type: row.type,
      at: row.at,
      data: jsonObject(parseJSON(row.data)),
      previousHash: row.previous_hash,
      hash: row.hash,
    }));
  }

  evidence() {
    return this.store.readTransaction(() => {
      const events = this.events({ limit: 60000 });
      const anchor = this.store.metadata('event_anchor')!;
      let previousHash = anchor;
      let previousSeq = null;
      let valid = true;
      for (const event of events) {
        const expected = digest(
          canonical({
            seq: event.seq,
            jobId: event.jobId,
            type: event.type,
            at: event.at,
            data: event.data,
            previousHash: event.previousHash,
          }),
        );
        if (
          event.previousHash !== previousHash ||
          event.hash !== expected ||
          (previousSeq !== null && event.seq !== previousSeq + 1)
        )
          valid = false;
        previousHash = event.hash;
        previousSeq = event.seq;
      }
      if (events.length && previousSeq !== Number(this.store.metadata('event_seq'))) valid = false;
      return {
        format: 'faultline-evidence-v1',
        generatedAt: this.clock(),
        integrity: { valid, count: events.length, anchor, head: previousHash },
        events,
      };
    });
  }
}
