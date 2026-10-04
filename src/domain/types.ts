// Wire states are a closed union. Storage rows are decoded before becoming DTOs.
export const STATES = [
  'queued',
  'running',
  'retry_wait',
  'succeeded',
  'dead',
  'cancelled',
] as const;
export type JobState = (typeof STATES)[number];
export type JobKind = 'digest' | 'csv_summary';
export const SCENARIO_NAMES = [
  'retry',
  'crash',
  'duplicate',
  'dead',
  'burst',
  'fence',
  'response-loss',
] as const;
export type Scenario = (typeof SCENARIO_NAMES)[number];
export type Clock = () => number;
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export interface JobError {
  code: string;
  message: string;
}
export interface JobDefinition {
  kind: JobKind;
  label: string;
  text: string;
  priority: number;
  maxAttempts: number;
  delayMs: number;
  scheduleMs: number;
  fault: { failFirst: number; crashOnce: boolean; stallOnce: boolean };
}
interface JobBase {
  id: string;
  seq: number;
  kind: JobKind;
  label: string;
  priority: number;
  attempt: number;
  maxAttempts: number;
  generation: number;
  revision: number;
  token: number;
  runAt: number;
  createdAt: number;
  updatedAt: number;
  error: JobError | null;
}
export type RunningJob = JobBase & {
  state: 'running';
  owner: string;
  leaseUntil: number;
  completedAt: null;
  result: null;
};
export type PendingJob = JobBase & {
  state: 'queued' | 'retry_wait';
  owner: null;
  leaseUntil: null;
  completedAt: null;
  result: null;
};
export type SucceededJob = JobBase & {
  state: 'succeeded';
  owner: null;
  leaseUntil: null;
  completedAt: number;
  result: JsonObject;
};
export type FailedJob = JobBase & {
  state: 'dead' | 'cancelled';
  owner: null;
  leaseUntil: null;
  completedAt: number;
  result: null;
};
export type Job = RunningJob | PendingJob | SucceededJob | FailedJob;
export type DefinedJob = Job & { definition: JobDefinition };
export type ClaimedJob = RunningJob & { definition: JobDefinition };
export type DetailedJob = DefinedJob & {
  attempts: AttemptRow[];
  receipts: ReceiptSummary[];
  events: Event[];
};
export type CommitOutcome = { accepted: true } | { accepted: false; reason: 'STALE_LEASE' };
export type FailureOutcome =
  | { accepted: true; state: 'dead' | 'retry_wait' }
  | { accepted: false; reason: 'STALE_LEASE' };
export type TransitionCommand =
  | { action: 'cancel'; expectedRevision: number }
  | { action: 'replay'; expectedRevision: number; clearFaults: boolean };
export type Deduplicated<T> = T & { deduplicated: boolean };
// Row interfaces describe the v1 SQL schema, not public lifecycle guarantees.
export interface JobRow {
  id: string;
  seq: number;
  kind: JobKind;
  label: string;
  state: JobState;
  definition: string;
  priority: number;
  attempt: number;
  max_attempts: number;
  generation: number;
  revision: number;
  lease_token: number;
  lease_owner: string | null;
  lease_until: number | null;
  run_at: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  last_error: string | null;
  result: string | null;
}
export type OwnedRow = JobRow & { state: 'running'; lease_owner: string; lease_until: number };
export interface AttemptRow {
  job_id: string;
  generation: number;
  number: number;
  worker_id: string;
  token: number;
  state: 'running' | 'expired' | 'failed' | 'succeeded' | 'cancelled';
  started_at: number;
  ended_at: number | null;
  error: string | null;
}
export interface ReceiptSummary {
  generation: number;
  token: number;
  committed_at: number;
}
export interface WorkerRow {
  id: string;
  slot: number;
  pid: number;
  phase: 'idle' | 'busy' | 'paused' | 'stopped';
  job_id: string | null;
  started_at: number;
  last_seen: number;
}
export interface Event {
  seq: number;
  jobId: string | null;
  type: string;
  at: number;
  data: JsonObject;
  previousHash: string;
  hash: string;
}
export interface EventRow {
  seq: number;
  job_id: string | null;
  type: string;
  at: number;
  data: string;
  previous_hash: string;
  hash: string;
}
export interface ExperimentRow {
  id: string;
  scenario: Scenario;
  created_at: number;
  start_seq: number;
  job_ids: string;
  submissions: number;
}
export interface Experiment {
  id: string;
  scenario: Scenario;
  createdAt: number;
  startSeq: number;
  submissions: number;
  jobIds: string[];
}
export interface Verdict {
  status: 'pass' | 'running' | 'fail';
  checks: { id: string; label: string; status: 'pass' | 'pending' | 'fail'; detail: string }[];
  scenario: { name: string; question: string };
}
export interface ExperimentReport {
  experiment: Experiment;
  jobs: DetailedJob[];
  verdict: Verdict;
  serverTime: number;
}
export interface EventsQuery {
  after?: number;
  jobId?: string | null;
  limit?: number;
  newest?: boolean;
}
export interface SnapshotQuery {
  state?: string;
  before?: number;
  limit?: number;
}
export interface RetentionOptions {
  days?: number;
  maxEvents?: number;
}
export function assertNever(value: never): never {
  throw new Error(`Unexpected state: ${String(value)}`);
}
