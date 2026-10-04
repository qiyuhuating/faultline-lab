import type {
  Job,
  RunningJob,
  SucceededJob,
  CommitOutcome,
  FailureOutcome,
  TransitionCommand,
} from '../../src/domain/types.ts';
import { assertNever } from '../../src/domain/types.ts';
import { Queue } from '../../src/queue.ts';

// These are compile-only tests. If a forbidden combination becomes assignable,
// the compiler reports an unused @ts-expect-error and fails the acceptance gate.
export function stateContracts(running: RunningJob, succeeded: SucceededJob, job: Job) {
  // @ts-expect-error A running job must retain its lease owner.
  const ownerless: RunningJob = { ...running, owner: null };
  // @ts-expect-error A running job must retain a lease deadline.
  const timeless: RunningJob = { ...running, leaseUntil: null };
  // @ts-expect-error A succeeded job must contain its committed result.
  const resultless: SucceededJob = { ...succeeded, result: null };
  // @ts-expect-error An unreduced union may have no current owner.
  const owner: string = job.owner;
  // @ts-expect-error Terminal states cannot hold a live lease.
  const zombie: SucceededJob = { ...succeeded, owner: running.owner };
  return [ownerless, timeless, resultless, owner, zombie];
}
export function outcomes(result: CommitOutcome, failure: FailureOutcome) {
  if (result.accepted) {
    // @ts-expect-error Accepted writes have no stale-lease rejection reason.
    return result.reason;
  }
  const reason: 'STALE_LEASE' = result.reason;
  if (failure.accepted) {
    const state: 'dead' | 'retry_wait' = failure.state;
    return [reason, state];
  }
  // @ts-expect-error Rejected failures cannot invent a resulting job state.
  return failure.state;
}
export function commands(queue: Queue) {
  // @ts-expect-error Cancellation does not accept replay-only options.
  const command: TransitionCommand = { action: 'cancel', expectedRevision: 1, clearFaults: true };
  // @ts-expect-error Workers cannot commit a missing result.
  queue.complete('id', 'worker', 1, null);
  // @ts-expect-error Unknown actions require runtime validation at the HTTP boundary.
  queue.transition('id', 'resolve', 1, 'request-key');
  // @ts-expect-error Unknown scenarios cannot escape the scenario parser.
  queue.experiment('pretend-success', 'request-key');
  // @ts-expect-error Pause is a boolean API contract.
  queue.setPaused('yes', 'request-key');
  return command;
}
export function exhaustive(job: Job) {
  switch (job.state) {
    case 'running':
      return job.owner;
    case 'queued':
    case 'retry_wait':
      return job.runAt;
    case 'succeeded':
      return job.result;
    case 'dead':
    case 'cancelled':
      return job.completedAt;
    default:
      return assertNever(job);
  }
}
