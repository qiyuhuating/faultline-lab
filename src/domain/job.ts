import type { Job, JobRow, DefinedJob, OwnedRow } from './types.ts';
import { assertNever } from './types.ts';
import { insist, jobDefinition, jsonObject, parseJSON } from '../validation.ts';

export function serialize(row: JobRow): Job;
export function serialize(row: JobRow, details: true): DefinedJob;
export function serialize(row: JobRow, details = false): Job | DefinedJob {
  const base = {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    label: row.label,
    priority: row.priority,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    generation: row.generation,
    revision: row.revision,
    token: row.lease_token,
    runAt: row.run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.last_error ? readError(row.last_error) : null,
  };
  let job: Job;
  switch (row.state) {
    case 'running':
      insist(
        typeof row.lease_owner === 'string' &&
          typeof row.lease_until === 'number' &&
          row.completed_at === null &&
          row.result === null,
        'STORAGE_INVALID',
        '运行任务的租约状态损坏。',
        500,
      );
      job = {
        ...base,
        state: row.state,
        owner: row.lease_owner,
        leaseUntil: row.lease_until,
        completedAt: null,
        result: null,
      };
      break;
    case 'queued':
    case 'retry_wait':
      insist(
        row.lease_owner === null &&
          row.lease_until === null &&
          row.completed_at === null &&
          row.result === null,
        'STORAGE_INVALID',
        '待处理任务状态损坏。',
        500,
      );
      job = {
        ...base,
        state: row.state,
        owner: null,
        leaseUntil: null,
        completedAt: null,
        result: null,
      };
      break;
    case 'succeeded':
      insist(
        row.lease_owner === null &&
          row.lease_until === null &&
          typeof row.completed_at === 'number' &&
          row.result !== null,
        'STORAGE_INVALID',
        '成功任务缺少完成结果。',
        500,
      );
      job = {
        ...base,
        state: row.state,
        owner: null,
        leaseUntil: null,
        completedAt: row.completed_at,
        result: jsonObject(parseJSON(row.result)),
      };
      break;
    case 'dead':
    case 'cancelled':
      insist(
        row.lease_owner === null &&
          row.lease_until === null &&
          typeof row.completed_at === 'number' &&
          row.result === null,
        'STORAGE_INVALID',
        '终态任务状态损坏。',
        500,
      );
      job = {
        ...base,
        state: row.state,
        owner: null,
        leaseUntil: null,
        completedAt: row.completed_at,
        result: null,
      };
      break;
    default:
      return assertNever(row.state);
  }
  return details ? { ...job, definition: jobDefinition(parseJSON(row.definition)) } : job;
}
function readError(text: string) {
  const value = jsonObject(parseJSON(text));
  insist(
    typeof value.code === 'string' && typeof value.message === 'string',
    'STORAGE_INVALID',
    '任务错误记录损坏。',
    500,
  );
  return { code: value.code, message: value.message };
}
export function owns(
  job: JobRow | undefined,
  workerId: string,
  token: number,
  now: number,
): job is OwnedRow {
  return (
    job?.state === 'running' &&
    job.lease_owner === workerId &&
    job.lease_token === token &&
    job.lease_until !== null &&
    job.lease_until > now
  );
}
