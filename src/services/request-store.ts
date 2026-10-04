import type { SqliteStore } from '../storage/sqlite-store.ts';
import type { EventLedger } from './event-ledger.ts';
import type { Clock, JsonObject, Deduplicated } from '../domain/types.ts';
import { canonical, digest, insist, key, jsonObject, parseJSON } from '../validation.ts';

// The durable fingerprint fixes the response type to the original operation.
export class RequestStore {
  readonly store: SqliteStore;
  readonly ledger: EventLedger;
  readonly clock: Clock;
  constructor(store: SqliteStore, ledger: EventLedger, clock: Clock) {
    this.store = store;
    this.ledger = ledger;
    this.clock = clock;
  }
  execute<T extends JsonObject>(
    operation: string,
    body: unknown,
    requestKey: string,
    fn: () => T,
  ): Deduplicated<T> {
    key(requestKey);
    const fingerprint = digest(canonical({ operation, body }));
    const previous = this.store.one<{ fingerprint: string; response: string }>(
      'SELECT * FROM requests WHERE key=?',
      requestKey,
    );
    if (previous) {
      insist(
        previous.fingerprint === fingerprint,
        'IDEMPOTENCY_CONFLICT',
        '同一幂等键不能用于不同请求。',
        409,
      );
      this.ledger.append('request.deduplicated', null, { operation });
      return { ...(jsonObject(parseJSON(previous.response)) as T), deduplicated: true };
    }
    const result = fn();
    this.store.run(
      'INSERT INTO requests VALUES (?, ?, ?, ?)',
      requestKey,
      fingerprint,
      JSON.stringify(result),
      this.clock(),
    );
    return { ...result, deduplicated: false };
  }

  status(requestKey: string) {
    key(requestKey);
    const row = this.store.one<{ response: string }>(
      'SELECT response FROM requests WHERE key=?',
      requestKey,
    );
    return {
      found: Boolean(row),
      result: row ? jsonObject(parseJSON(row.response)) : null,
      serverTime: this.clock(),
    };
  }
}
