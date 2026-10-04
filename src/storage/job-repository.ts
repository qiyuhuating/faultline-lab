import type { JobDefinition, JobRow } from '../domain/types.ts';
import type { SqliteStore } from './sqlite-store.ts';
import { canonical } from '../validation.ts';

// Persistence only: no clock, transaction ownership, retry policy or events.
export class JobRepository {
  readonly store: SqliteStore;
  constructor(store: SqliteStore) {
    this.store = store;
  }
  count() {
    return this.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM jobs')!.n;
  }
  find(id: string) {
    return this.store.one<JobRow>('SELECT * FROM jobs WHERE id=?', id);
  }
  insert(id: string, definition: JobDefinition, now: number) {
    this.store.run(
      `INSERT INTO jobs
      (id, kind, label, definition, state, priority, max_attempts, run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      id,
      definition.kind,
      definition.label,
      canonical(definition),
      definition.priority,
      definition.maxAttempts,
      now + definition.scheduleMs,
      now,
      now,
    );
  }
  expired(now: number) {
    return this.store.all<JobRow>(
      "SELECT * FROM jobs WHERE state='running' AND lease_until<=?",
      now,
    );
  }
  due(now: number) {
    return this.store.one<JobRow>(
      `SELECT * FROM jobs WHERE state IN ('queued','retry_wait')
      AND run_at<=? AND attempt<max_attempts ORDER BY priority DESC, run_at, seq LIMIT 1`,
      now,
    );
  }
  claim(
    job: JobRow,
    workerId: string,
    token: number,
    number: number,
    now: number,
    leaseMs: number,
  ) {
    this.store.run(
      `UPDATE jobs SET state='running', attempt=?, lease_token=?, lease_owner=?,
      lease_until=?, updated_at=?, revision=revision+1 WHERE id=?`,
      number,
      token,
      workerId,
      now + leaseMs,
      now,
      job.id,
    );
    this.store.run(
      'INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      job.id,
      job.generation,
      number,
      workerId,
      token,
      'running',
      now,
      null,
      null,
    );
    this.store.run(
      "UPDATE workers SET phase='busy', job_id=?, last_seen=? WHERE id=?",
      job.id,
      now,
      workerId,
    );
  }
  renew(id: string, workerId: string, token: number, now: number, leaseMs: number) {
    return (
      this.store.run(
        `UPDATE jobs SET lease_until=? WHERE id=? AND state='running'
      AND lease_owner=? AND lease_token=? AND lease_until>?`,
        now + leaseMs,
        id,
        workerId,
        token,
        now,
      ).changes === 1
    );
  }
  expire(job: JobRow, state: 'dead' | 'retry_wait', error: string, runAt: number, now: number) {
    this.store.run(
      `UPDATE attempts SET state='expired', ended_at=?, error=?
      WHERE job_id=? AND generation=? AND number=? AND state='running'`,
      now,
      error,
      job.id,
      job.generation,
      job.attempt,
    );
    this.store.run(
      `UPDATE jobs SET state=?, lease_owner=NULL, lease_until=NULL,
      run_at=?, updated_at=?, revision=revision+1, completed_at=?, last_error=? WHERE id=?`,
      state,
      runAt,
      now,
      state === 'dead' ? now : null,
      error,
      job.id,
    );
  }
  complete(job: JobRow, token: number, encoded: string, now: number) {
    this.store.run(
      'INSERT INTO receipts VALUES (?, ?, ?, ?, ?)',
      job.id,
      job.generation,
      token,
      encoded,
      now,
    );
    this.store.run(
      `UPDATE attempts SET state='succeeded', ended_at=? WHERE job_id=? AND generation=? AND number=?`,
      now,
      job.id,
      job.generation,
      job.attempt,
    );
    this.store.run(
      `UPDATE jobs SET state='succeeded', result=?, completed_at=?, updated_at=?,
      lease_owner=NULL, lease_until=NULL, revision=revision+1 WHERE id=?`,
      encoded,
      now,
      now,
      job.id,
    );
  }
  fail(job: JobRow, state: 'dead' | 'retry_wait', error: string, runAt: number, now: number) {
    this.store.run(
      `UPDATE attempts SET state='failed', ended_at=?, error=? WHERE job_id=? AND generation=? AND number=?`,
      now,
      error,
      job.id,
      job.generation,
      job.attempt,
    );
    this.store.run(
      `UPDATE jobs SET state=?, last_error=?, run_at=?, updated_at=?, completed_at=?,
      lease_owner=NULL, lease_until=NULL, revision=revision+1 WHERE id=?`,
      state,
      error,
      runAt,
      now,
      state === 'dead' ? now : null,
      job.id,
    );
  }
  cancel(job: JobRow, now: number) {
    if (job.state === 'running')
      this.store.run(
        "UPDATE attempts SET state='cancelled', ended_at=? WHERE job_id=? AND generation=? AND number=?",
        now,
        job.id,
        job.generation,
        job.attempt,
      );
    this.store.run(
      `UPDATE jobs SET state='cancelled', completed_at=?, updated_at=?, revision=revision+1,
      lease_token=lease_token+1, lease_owner=NULL, lease_until=NULL WHERE id=?`,
      now,
      now,
      job.id,
    );
  }
  replay(id: string, definition: JobDefinition, now: number) {
    this.store.run(
      `UPDATE jobs SET state='queued', generation=generation+1, attempt=0,
      revision=revision+1, lease_token=lease_token+1, lease_owner=NULL, lease_until=NULL,
      completed_at=NULL, result=NULL, last_error=NULL, run_at=?, updated_at=?, definition=? WHERE id=?`,
      now,
      now,
      canonical(definition),
      id,
    );
  }
}
