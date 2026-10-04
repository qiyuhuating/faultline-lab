import type { SqliteStore } from '../storage/sqlite-store.ts';
import type { JobRepository } from '../storage/job-repository.ts';
import type { EventLedger } from './event-ledger.ts';
import type {
  Clock,
  ClaimedJob,
  JsonObject,
  CommitOutcome,
  FailureOutcome,
  WorkerRow,
} from '../domain/types.ts';
import { serialize, owns } from '../domain/job.ts';
import { canonical, digest, insist, jsonObject } from '../validation.ts';
export const LEASE_MS = 2400;
export class LeaseService {
  readonly store: SqliteStore;
  readonly repository: JobRepository;
  readonly ledger: EventLedger;
  readonly clock: Clock;
  readonly leaseMs: number;
  constructor(
    store: SqliteStore,
    repository: JobRepository,
    ledger: EventLedger,
    clock: Clock,
    leaseMs: number,
  ) {
    this.store = store;
    this.repository = repository;
    this.ledger = ledger;
    this.clock = clock;
    this.leaseMs = leaseMs;
  }
  backoff(id: string, attempt: number) {
    const jitter = parseInt(digest(`${id}:${attempt}`).slice(0, 6), 16) / 0xffffff;
    return Math.round(Math.min(6000, 500 * 2 ** (attempt - 1)) * (0.8 + jitter * 0.4));
  }

  expire(now: number) {
    const expired = this.repository.expired(now);
    for (const job of expired) {
      const dead = job.attempt >= job.max_attempts;
      const error = { code: 'LEASE_EXPIRED', message: 'Worker 未在租约内完成或续约。' };
      this.repository.expire(
        job,
        dead ? 'dead' : 'retry_wait',
        JSON.stringify(error),
        now + this.backoff(job.id, job.attempt),
        now,
      );
      this.ledger.append(
        'lease.expired',
        job.id,
        {
          workerId: job.lease_owner,
          token: job.lease_token,
          attempt: job.attempt,
          nextState: dead ? 'dead' : 'retry_wait',
        },
        now,
      );
    }
    return expired.length;
  }

  recover() {
    return this.store.transaction(() => this.expire(this.clock()));
  }

  claim(workerId: string): ClaimedJob | null {
    return this.store.transaction(() => {
      const now = this.clock();
      this.expire(now);
      const worker = this.store.one<WorkerRow>('SELECT * FROM workers WHERE id=?', workerId);
      insist(worker && worker.phase !== 'stopped', 'WORKER_UNKNOWN', 'Worker 未注册。', 409);
      if (this.store.metadata('paused') === 'true') return null;
      // BEGIN IMMEDIATE serializes competing claimers across independent processes.
      const job = this.repository.due(now);
      if (!job) return null;
      const token = job.lease_token + 1;
      const number = job.attempt + 1;
      this.repository.claim(job, workerId, token, number, now, this.leaseMs);
      this.ledger.append(
        'lease.claimed',
        job.id,
        { workerId, token, attempt: number, generation: job.generation },
        now,
      );
      const claimed = serialize(this.repository.find(job.id)!, true);
      insist(claimed.state === 'running', 'STORAGE_INVALID', '领取未产生运行状态。', 500);
      return claimed;
    });
  }

  renew(id: string, workerId: string, token: number) {
    return this.store.transaction(() => {
      // Waiting for a writer lock may outlast the lease. Check time only after
      // BEGIN IMMEDIATE has acquired it, just as complete/fail already do.
      const now = this.clock();
      return this.repository.renew(id, workerId, token, now, this.leaseMs);
    });
  }

  complete(id: string, workerId: string, token: number, result: JsonObject): CommitOutcome {
    return this.store.transaction(() => {
      const now = this.clock();
      const job = this.repository.find(id);
      if (!owns(job, workerId, token, now)) {
        if (job)
          this.ledger.append(
            'commit.rejected',
            id,
            {
              workerId,
              token,
              currentToken: job.lease_token,
              currentState: job.state,
              reason: 'STALE_LEASE',
            },
            now,
          );
        return { accepted: false, reason: 'STALE_LEASE' };
      }
      const encoded = canonical(jsonObject(result));
      // The built-in result receipt and state change commit in one transaction.
      this.repository.complete(job, token, encoded, now);
      this.ledger.append(
        'job.succeeded',
        id,
        {
          workerId,
          token,
          attempt: job.attempt,
          generation: job.generation,
          resultHash: digest(encoded),
        },
        now,
      );
      return { accepted: true };
    });
  }

  fail(id: string, workerId: string, token: number, error: unknown): FailureOutcome {
    return this.store.transaction(() => {
      const now = this.clock();
      const job = this.repository.find(id);
      if (!owns(job, workerId, token, now)) return { accepted: false, reason: 'STALE_LEASE' };
      const dead = job.attempt >= job.max_attempts;
      const detail =
        error && typeof error === 'object' ? (error as { code?: unknown; message?: unknown }) : {};
      const safeError = {
        code: String(detail.code ?? 'HANDLER_FAILED').slice(0, 60),
        message: String(detail.message ?? '任务处理失败').slice(0, 200),
      };
      const runAt = now + this.backoff(id, job.attempt);
      this.repository.fail(
        job,
        dead ? 'dead' : 'retry_wait',
        JSON.stringify(safeError),
        runAt,
        now,
      );
      this.ledger.append(
        dead ? 'job.dead' : 'job.retry_scheduled',
        id,
        {
          attempt: job.attempt,
          generation: job.generation,
          workerId,
          token,
          error: safeError,
          retryAt: dead ? null : runAt,
        },
        now,
      );
      return { accepted: true, state: dead ? 'dead' : 'retry_wait' };
    });
  }
}
