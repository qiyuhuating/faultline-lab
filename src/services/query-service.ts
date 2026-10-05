import type { SqliteStore } from '../storage/sqlite-store.ts';
import type { EventLedger } from './event-ledger.ts';
import type {
  Clock,
  JobRow,
  JobState,
  WorkerRow,
  AttemptRow,
  ReceiptSummary,
  ExperimentRow,
  Experiment,
  ExperimentReport,
  DetailedJob,
  SnapshotQuery,
} from '../domain/types.ts';
import { STATES } from '../domain/types.ts';
import { serialize } from '../domain/job.ts';
import { DomainError, insist, parseJSON } from '../validation.ts';
import { evaluateExperiment } from '../../public/proof.mjs';
export class QueryService {
  readonly store: SqliteStore;
  readonly ledger: EventLedger;
  readonly clock: Clock;
  readonly raw: (id: string) => JobRow | undefined;
  readonly reportCache = new Map<string, { stamp: string; report: ExperimentReport }>();
  constructor(
    store: SqliteStore,
    ledger: EventLedger,
    clock: Clock,
    raw: (id: string) => JobRow | undefined,
  ) {
    this.store = store;
    this.ledger = ledger;
    this.clock = clock;
    this.raw = raw;
  }
  detail(id: string): DetailedJob {
    return this.store.readTransaction(() => {
      const row = this.raw(id);
      if (!row) throw new DomainError('NOT_FOUND', '任务不存在。', 404);
      const job = serialize(row, true);
      const attempts = this.store.all<AttemptRow>(
        'SELECT * FROM attempts WHERE job_id=? ORDER BY generation, number',
        id,
      );
      const receipts = this.store.all<ReceiptSummary>(
        'SELECT generation, token, committed_at FROM receipts WHERE job_id=? ORDER BY generation',
        id,
      );
      const events = this.ledger.events({ jobId: id, limit: 500 });
      return { ...job, attempts, receipts, events };
    });
  }

  experimentReport(id: string): ExperimentReport {
    // An outer transaction may roll back after this report has been computed.
    const cacheable = !this.store.db.isTransaction;
    return this.store.readTransaction(() => {
      const dataVersion = this.store.one<{ data_version: number }>(
        'PRAGMA data_version',
      )!.data_version;
      const changes = this.store.one<{ changes: number }>(
        'SELECT total_changes() changes',
      )!.changes;
      const stamp = `${dataVersion}:${changes}:${this.store.metadata('event_seq')}:${Math.floor(this.clock() / 1000)}`;
      const cached = cacheable ? this.reportCache.get(id) : undefined;
      if (cached?.stamp === stamp) return cached.report;
      const row = this.store.one<ExperimentRow>('SELECT * FROM experiments WHERE id=?', id);
      if (!row) throw new DomainError('NOT_FOUND', '实验不存在或已超过保留期限。', 404);
      const parsed = parseJSON(row.job_ids);
      insist(
        Array.isArray(parsed) && parsed.every((id): id is string => typeof id === 'string'),
        'STORAGE_INVALID',
        '实验任务引用损坏。',
        500,
      );
      const jobIds: string[] = parsed;
      const jobs = jobIds.map((jobId) => this.detail(jobId));
      const experiment: Experiment = {
        id,
        scenario: row.scenario,
        createdAt: row.created_at,
        startSeq: row.start_seq,
        submissions: row.submissions,
        jobIds,
      };
      const report: ExperimentReport = {
        experiment,
        jobs,
        verdict: evaluateExperiment(experiment, jobs, this.clock()),
        serverTime: this.clock(),
      };
      if (cacheable) {
        this.reportCache.set(id, { stamp, report });
        if (this.reportCache.size > 16)
          this.reportCache.delete(this.reportCache.keys().next().value!);
      }
      return report;
    });
  }

  experiments(limit = 8) {
    return this.store
      .all<{
        id: string;
      }>('SELECT id FROM experiments ORDER BY created_at DESC, rowid DESC LIMIT ?', limit)
      .map((row) => {
        const report = this.experimentReport(row.id);
        return {
          ...report,
          jobs: report.jobs.map((job) => ({
            id: job.id,
            state: job.state,
            generation: job.generation,
            revision: job.revision,
          })),
        };
      });
  }

  snapshot({ state = '', before = Number.MAX_SAFE_INTEGER, limit = 40 }: SnapshotQuery = {}) {
    return this.store.readTransaction(() => {
      insist(state === '' || STATES.some((s) => s === state), 'VALIDATION', '状态筛选无效。');
      insist(Number.isSafeInteger(before) && before > 0, 'VALIDATION', '分页游标无效。');
      const rows = state
        ? this.store.all<JobRow>(
            'SELECT * FROM jobs WHERE state=? AND seq<? ORDER BY seq DESC LIMIT ?',
            state,
            before,
            limit + 1,
          )
        : this.store.all<JobRow>(
            'SELECT * FROM jobs WHERE seq<? ORDER BY seq DESC LIMIT ?',
            before,
            limit + 1,
          );
      const counts: Record<JobState, number> = {
        queued: 0,
        running: 0,
        retry_wait: 0,
        succeeded: 0,
        dead: 0,
        cancelled: 0,
      };
      for (const row of this.store.all<{ state: JobState; n: number }>(
        'SELECT state, COUNT(*) n FROM jobs GROUP BY state',
      ))
        counts[row.state] = row.n;
      const now = this.clock();
      const workers = this.store
        .all<WorkerRow>('SELECT * FROM workers ORDER BY last_seen DESC, started_at DESC LIMIT 8')
        .map((w) => ({ ...w, online: w.phase !== 'stopped' && now - w.last_seen < 3000 }));
      const recent = this.store.one<{ n: number; avg: number | null }>(
        "SELECT COUNT(*) n, AVG(ended_at-started_at) avg FROM attempts WHERE state='succeeded' AND ended_at>?",
        now - 60000,
      )!;
      const series = [];
      const start = Math.floor(now / 10000) * 10000 - 110000;
      for (let i = 0; i < 12; i++) {
        const at = start + i * 10000;
        const sample = this.store.one<{ n: number }>(
          "SELECT COUNT(*) n FROM attempts WHERE state='succeeded' AND ended_at>=? AND ended_at<?",
          at,
          at + 10000,
        )!;
        series.push({ at, completed: sample.n });
      }
      const jobs = rows.slice(0, limit).map((row) => serialize(row));
      return {
        serverTime: now,
        revision: Number(this.store.metadata('event_seq')),
        paused: this.store.metadata('paused') === 'true',
        jobs,
        counts,
        workers,
        nextBefore: rows.length > limit ? jobs.at(-1)!.seq : null,
        metrics: {
          completedLastMinute: recent.n,
          averageExecutionMs: Math.round(recent.avg ?? 0),
          receipts: this.store.one<{ n: number }>('SELECT COUNT(*) n FROM receipts')!.n,
          deduplicated: this.store.one<{ n: number }>(
            "SELECT COUNT(*) n FROM events WHERE type='request.deduplicated'",
          )!.n,
        },
        series,
        events: this.ledger.events({ newest: true, limit: 12 }),
        experiments: this.experiments(),
      };
    });
  }
}
