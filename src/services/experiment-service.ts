import { randomUUID } from 'node:crypto';
import type { SqliteStore } from '../storage/sqlite-store.ts';
import type { JobService } from './job-service.ts';
import type { EventLedger } from './event-ledger.ts';
import type { RequestStore } from './request-store.ts';
import type { Clock, Scenario } from '../domain/types.ts';
import { digest, scenario as parseScenario, jobDefinition } from '../validation.ts';
export class ExperimentService {
  readonly store: SqliteStore;
  readonly jobs: JobService;
  readonly ledger: EventLedger;
  readonly requests: RequestStore;
  readonly clock: Clock;
  constructor(
    store: SqliteStore,
    jobs: JobService,
    ledger: EventLedger,
    requests: RequestStore,
    clock: Clock,
  ) {
    this.store = store;
    this.jobs = jobs;
    this.ledger = ledger;
    this.requests = requests;
    this.clock = clock;
  }
  start(name: unknown, requestKey: string) {
    const scenario = parseScenario(name);
    return this.store.transaction(() =>
      this.requests.execute('experiment', { name: scenario }, requestKey, () => {
        const experimentId = randomUUID();
        const createdAt = this.clock();
        const startSeq = Number(this.store.metadata('event_seq'));
        const common = { text: 'Faultline / reproducible execution / 2026', delayMs: 700 };
        const definitions: Record<Exclude<Scenario, 'burst'>, unknown> = {
          retry: { ...common, label: 'Transient failure · 自动重试', fault: { failFirst: 2 } },
          crash: { ...common, label: 'Process crash · 租约恢复', fault: { crashOnce: true } },
          fence: { ...common, label: 'Zombie worker · 旧提交拒绝', fault: { stallOnce: true } },
          'response-loss': { ...common, label: 'Lost response · 写入结果确认' },
          duplicate: { ...common, label: 'Repeated intent · 幂等去重' },
          dead: {
            ...common,
            label: 'Retry exhausted · 死信',
            maxAttempts: 3,
            fault: { failFirst: 10 },
          },
        };
        const ids: string[] = [];
        if (scenario === 'burst') {
          for (let i = 0; i < 24; i++)
            ids.push(
              this.jobs.insert(
                jobDefinition({
                  ...common,
                  label: `Burst task ${String(i + 1).padStart(2, '0')}`,
                  delayMs: 150,
                }),
              ),
            );
        } else if (scenario === 'duplicate') {
          const definition = jobDefinition(definitions.duplicate);
          // Exercise the very same idempotency primitive three times, atomically.
          for (let i = 0; i < 3; i++) {
            const submitted = this.requests.execute(
              'submit',
              definition,
              `${digest(requestKey)}:inner`,
              () => ({ jobId: this.jobs.insert(definition) }),
            );
            ids.push(submitted.jobId);
          }
        } else ids.push(this.jobs.insert(jobDefinition(definitions[scenario])));
        const jobIds = [...new Set(ids)];
        this.store.run(
          'INSERT INTO experiments VALUES (?, ?, ?, ?, ?, ?)',
          experimentId,
          scenario,
          createdAt,
          startSeq,
          JSON.stringify(jobIds),
          ids.length,
        );
        this.ledger.append('experiment.started', null, {
          experimentId,
          name: scenario,
          submissions: ids.length,
          uniqueJobs: jobIds.length,
        });
        return { experimentId, jobIds, submissions: ids.length };
      }),
    );
  }
}
