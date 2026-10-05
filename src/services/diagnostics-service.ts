import type { SQLInputValue } from 'node:sqlite';
import type { Clock, JsonObject, JobRow } from '../domain/types.ts';
import type { SqliteStore } from '../storage/sqlite-store.ts';
import type { EventLedger } from './event-ledger.ts';
import { errorMessage } from '../validation.ts';
import { serialize } from '../domain/job.ts';

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  evidence: JsonObject;
}
export interface DiagnosticsReport {
  format: 'faultline-diagnostics-v1';
  generatedAt: number;
  verdict: 'pass' | 'warn' | 'fail';
  checks: DiagnosticCheck[];
  counts: { jobs: number; attempts: number; receipts: number; events: number };
  notice: string;
}
// Observation only. No tick, schema migration, recovery, checkpoint or repairs.
export class DiagnosticsService {
  readonly store: SqliteStore;
  readonly ledger: EventLedger;
  readonly clock: Clock;
  constructor(store: SqliteStore, ledger: EventLedger, clock: Clock) {
    this.store = store;
    this.ledger = ledger;
    this.clock = clock;
  }
  inspect(): DiagnosticsReport {
    return this.store.readTransaction(() => {
      const checks: DiagnosticCheck[] = [];
      const count = (table: 'jobs' | 'attempts' | 'receipts' | 'events') =>
        this.store.one<{ n: number }>(`SELECT COUNT(*) n FROM ${table}`)!.n;
      const checkRows = (
        id: string,
        label: string,
        sql: string,
        warning = false,
        params: SQLInputValue[] = [],
      ) => {
        const rows = this.store.all<{ id: string }>(`SELECT id FROM (${sql}) LIMIT 20`, ...params);
        checks.push({
          id,
          label,
          status: rows.length ? (warning ? 'warn' : 'fail') : 'pass',
          evidence: { sampleIds: rows.map((row) => row.id), sampleLimit: 20, atLeast: rows.length },
        });
      };
      const physical = this.store.all<Record<string, string>>('PRAGMA quick_check(10)');
      const physicalIssues = physical
        .flatMap((row) => Object.values(row))
        .filter((value) => value !== 'ok');
      checks.push({
        id: 'sqlite',
        label: 'SQLite 页与索引完整',
        status: physicalIssues.length ? 'fail' : 'pass',
        evidence: { issues: physicalIssues },
      });
      let foreignCount = 0;
      for (const _row of this.store.iterate<Record<string, unknown>>('PRAGMA foreign_key_check'))
        foreignCount++;
      checks.push({
        id: 'foreign-keys',
        label: '关联记录没有孤儿',
        status: foreignCount ? 'fail' : 'pass',
        evidence: { violations: foreignCount },
      });
      checkRows(
        'job-lifecycle',
        '状态、租约与完成结果一致',
        `SELECT id FROM jobs WHERE
        (state='running' AND (lease_owner IS NULL OR lease_until IS NULL OR completed_at IS NOT NULL OR result IS NOT NULL OR attempt<1 OR lease_token<1)) OR
        (state IN ('queued','retry_wait') AND (lease_owner IS NOT NULL OR lease_until IS NOT NULL OR completed_at IS NOT NULL OR result IS NOT NULL)) OR
        (state IN ('succeeded','dead','cancelled') AND (lease_owner IS NOT NULL OR lease_until IS NOT NULL OR completed_at IS NULL)) OR
        (state='succeeded' AND result IS NULL) OR (state IN ('dead','cancelled') AND result IS NOT NULL) OR
        state NOT IN ('queued','running','retry_wait','succeeded','dead','cancelled') OR kind NOT IN ('digest','csv_summary') OR attempt<0 OR attempt>max_attempts OR generation<0 OR generation>20 OR revision<1 OR lease_token<0`,
      );
      checkRows(
        'receipt-state',
        '成功状态与本轮唯一收据对应',
        `SELECT j.id FROM jobs j LEFT JOIN receipts r ON r.job_id=j.id AND r.generation=j.generation WHERE
        (j.state='succeeded' AND (r.job_id IS NULL OR r.token!=j.lease_token OR r.result!=j.result OR r.committed_at!=j.completed_at)) OR
        (j.state!='succeeded' AND r.job_id IS NOT NULL)`,
      );
      checkRows(
        'receipt-owner',
        '收据来自成功的获胜尝试',
        `SELECT r.job_id id FROM receipts r LEFT JOIN attempts a ON a.job_id=r.job_id AND a.generation=r.generation AND a.token=r.token WHERE a.job_id IS NULL OR a.state!='succeeded' OR a.ended_at IS NULL OR a.ended_at!=r.committed_at`,
      );
      checkRows(
        'running-attempt',
        '运行尝试和当前租约相互对应',
        `SELECT j.id FROM jobs j LEFT JOIN attempts a ON a.job_id=j.id AND a.generation=j.generation AND a.number=j.attempt WHERE j.state='running' AND (a.job_id IS NULL OR a.state!='running' OR a.worker_id!=j.lease_owner OR a.token!=j.lease_token OR a.ended_at IS NOT NULL)
        UNION SELECT a.job_id id FROM attempts a JOIN jobs j ON j.id=a.job_id WHERE a.state='running' AND (j.state!='running' OR a.generation!=j.generation OR a.number!=j.attempt OR a.token!=j.lease_token OR a.worker_id!=j.lease_owner)`,
      );
      checkRows(
        'attempt-receipt',
        '成功尝试没有遗失收据',
        `SELECT a.job_id id FROM attempts a LEFT JOIN receipts r ON r.job_id=a.job_id AND r.generation=a.generation AND r.token=a.token WHERE a.state='succeeded' AND r.job_id IS NULL`,
      );
      const unreadable: string[] = [];
      for (const row of this.store.iterate<JobRow>('SELECT * FROM jobs')) {
        try {
          serialize(row, true);
        } catch {
          if (unreadable.length < 20) unreadable.push(row.id);
        }
      }
      checks.push({
        id: 'json-records',
        label: '持久化任务与 JSON 结构可读取',
        status: unreadable.length ? 'fail' : 'pass',
        evidence: { sampleIds: unreadable, sampleLimit: 20, atLeast: unreadable.length },
      });
      checkRows(
        'attempt-lifecycle',
        '尝试状态与结束时间一致',
        `SELECT job_id id FROM attempts WHERE state NOT IN ('running','succeeded','failed','expired','cancelled') OR (state='running' AND ended_at IS NOT NULL) OR (state!='running' AND ended_at IS NULL) OR token<1 OR number<1 OR generation<0`,
      );
      checkRows(
        'attempt-history',
        '尝试编号连续并与当前轮次计数一致',
        `SELECT j.id FROM jobs j WHERE j.attempt!=(SELECT COUNT(*) FROM attempts a WHERE a.job_id=j.id AND a.generation=j.generation)
        UNION SELECT a.job_id id FROM attempts a JOIN jobs j ON j.id=a.job_id GROUP BY a.job_id,a.generation HAVING a.generation>j.generation OR MIN(a.number)!=1 OR MAX(a.number)!=COUNT(*)`,
      );
      checkRows(
        'request-records',
        '持久化请求结果可读取',
        `SELECT key id FROM requests WHERE CASE WHEN json_valid(response) THEN json_type(response)!='object' ELSE 1 END`,
      );
      try {
        const integrity = this.ledger.inspect();
        checks.push({
          id: 'event-chain',
          label: '事件链内容与保留区间完整',
          status: integrity.valid
            ? integrity.range.source === 'legacy-inferred'
              ? 'warn'
              : 'pass'
            : 'fail',
          evidence: {
            valid: integrity.valid,
            count: integrity.count,
            anchorSequence: integrity.range.anchorSequence,
            headSequence: integrity.range.headSequence,
            rangeSource: integrity.range.source,
          },
        });
      } catch (error) {
        checks.push({
          id: 'event-chain',
          label: '事件链内容与保留区间完整',
          status: 'fail',
          evidence: { error: errorMessage(error).slice(0, 200) },
        });
      }
      const now = this.clock();
      checkRows(
        'expired-leases',
        '过期租约等待接管',
        `SELECT id FROM jobs WHERE state='running' AND lease_until<=?`,
        true,
        [now],
      );
      checkRows(
        'offline-owners',
        '活跃租约的 Worker 最近仍在线',
        `SELECT j.id FROM jobs j LEFT JOIN workers w ON w.id=j.lease_owner WHERE j.state='running' AND (w.id IS NULL OR w.phase='stopped' OR w.last_seen<?)`,
        true,
        [now - 3000],
      );
      return {
        format: 'faultline-diagnostics-v1',
        generatedAt: now,
        verdict: checks.some((c) => c.status === 'fail')
          ? 'fail'
          : checks.some((c) => c.status === 'warn')
            ? 'warn'
            : 'pass',
        checks,
        counts: {
          jobs: count('jobs'),
          attempts: count('attempts'),
          receipts: count('receipts'),
          events: count('events'),
        },
        notice: '只读一致性诊断；不修复数据，不证明外部副作用或第三方真实性。',
      };
    });
  }
}
