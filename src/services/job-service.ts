import { randomUUID } from 'node:crypto';
import type { JobDefinition, TransitionCommand } from '../domain/types.ts';
import type { SqliteStore } from '../storage/sqlite-store.ts';
import type { JobRepository } from '../storage/job-repository.ts';
import type { EventLedger } from './event-ledger.ts';
import type { RequestStore } from './request-store.ts';
import type { Clock } from '../domain/types.ts';
import { insist, jobDefinition, revision, parseJSON } from '../validation.ts';
const TERMINAL = new Set(['succeeded', 'dead', 'cancelled']);
export class JobService {
  readonly store: SqliteStore;
  readonly repository: JobRepository;
  readonly ledger: EventLedger;
  readonly requests: RequestStore;
  readonly clock: Clock;
  constructor(
    store: SqliteStore,
    repository: JobRepository,
    ledger: EventLedger,
    requests: RequestStore,
    clock: Clock,
  ) {
    this.store = store;
    this.repository = repository;
    this.ledger = ledger;
    this.requests = requests;
    this.clock = clock;
  }
  insert(definition: JobDefinition) {
    insist(
      !/[\uD800-\uDFFF]/u.test(definition.label),
      'VALIDATION',
      '任务名称不能包含不完整的 Unicode 字符。',
    );
    const count = this.repository.count();
    insist(
      count < 10000,
      'CAPACITY',
      '实验库最多保留 10,000 个任务，请先执行保留策略或使用新的数据目录。',
      429,
    );
    const id = randomUUID();
    const now = this.clock();
    this.repository.insert(id, definition, now);
    this.ledger.append(
      'job.created',
      id,
      { label: definition.label, kind: definition.kind, maxAttempts: definition.maxAttempts },
      now,
    );
    return id;
  }

  submit(input: unknown, requestKey: string) {
    const definition = jobDefinition(input);
    return this.store.transaction(() =>
      this.requests.execute('submit', definition, requestKey, () => ({
        jobId: this.insert(definition),
      })),
    );
  }

  transition(
    id: string,
    action: unknown,
    expectedRevision: unknown,
    requestKey: string,
    { clearFaults = false }: { clearFaults?: unknown } = {},
  ) {
    const expected = revision(expectedRevision);
    insist(action === 'cancel' || action === 'replay', 'VALIDATION', '操作不受支持。');
    insist(typeof clearFaults === 'boolean', 'VALIDATION', 'clearFaults 必须是布尔值。');
    const command: TransitionCommand =
      action === 'cancel'
        ? { action, expectedRevision: expected }
        : { action, expectedRevision: expected, clearFaults };
    return this.store.transaction(() =>
      this.requests.execute(
        'transition',
        { id, action, expectedRevision, clearFaults },
        requestKey,
        () => {
          const job = this.repository.find(id);
          insist(job, 'NOT_FOUND', '任务不存在。', 404);
          insist(
            job.revision === command.expectedRevision,
            'REVISION_CONFLICT',
            '任务已变化，请读取最新版本再操作。',
            409,
          );
          const now = this.clock();
          if (command.action === 'cancel') {
            insist(!TERMINAL.has(job.state), 'INVALID_TRANSITION', '终态任务不能取消。', 409);
            this.repository.cancel(job, now);
          } else {
            insist(
              ['dead', 'cancelled'].includes(job.state),
              'INVALID_TRANSITION',
              '只有死信或已取消的任务可以重放。',
              409,
            );
            insist(
              job.generation < 20,
              'REPLAY_LIMIT',
              '每个任务最多重放 20 次，请创建新任务。',
              409,
            );
            const definition = jobDefinition(parseJSON(job.definition));
            if (command.clearFaults)
              definition.fault = { failFirst: 0, crashOnce: false, stallOnce: false };
            this.repository.replay(id, definition, now);
          }
          this.ledger.append(
            `job.${action === 'cancel' ? 'cancelled' : 'replayed'}`,
            id,
            {
              previousState: job.state,
              previousRevision: job.revision,
              clearFaults,
              generation: action === 'replay' ? job.generation + 1 : job.generation,
            },
            now,
          );
          return { jobId: id, revision: job.revision + 1 };
        },
      ),
    );
  }

  setPaused(paused: unknown, requestKey: string) {
    insist(typeof paused === 'boolean', 'VALIDATION', 'paused 必须是布尔值。');
    return this.store.transaction(() =>
      this.requests.execute('pause', { paused }, requestKey, () => {
        this.store.run("UPDATE meta SET value=? WHERE key='paused'", String(paused));
        this.ledger.append(paused ? 'queue.paused' : 'queue.resumed', null, { paused });
        return { paused };
      }),
    );
  }
}
