import type {
  Clock,
  EventsQuery,
  JsonObject,
  RetentionOptions,
  Scenario,
  SnapshotQuery,
} from './domain/types.ts';
import { SqliteStore } from './storage/sqlite-store.ts';
import { JobRepository } from './storage/job-repository.ts';
import { EventLedger } from './services/event-ledger.ts';
import { RequestStore } from './services/request-store.ts';
import { JobService } from './services/job-service.ts';
import { LeaseService, LEASE_MS } from './services/lease-service.ts';
import { WorkerRegistry } from './services/worker-registry.ts';
import { ExperimentService } from './services/experiment-service.ts';
import { QueryService } from './services/query-service.ts';
import { DiagnosticsService } from './services/diagnostics-service.ts';
import { RetentionService } from './services/retention-service.ts';
export { LEASE_MS };

// Composition and compatibility facade. All services share one transaction owner.
export class Queue {
  clock: Clock;
  readonly leaseMs: number;
  private readonly store: SqliteStore;
  private readonly repository: JobRepository;
  private readonly ledger: EventLedger;
  private readonly requests: RequestStore;
  private readonly jobs: JobService;
  private readonly leases: LeaseService;
  private readonly workers: WorkerRegistry;
  private readonly experimentsService: ExperimentService;
  private readonly queries: QueryService;
  private readonly retention: RetentionService;

  constructor(
    path: string,
    { clock = Date.now, leaseMs = LEASE_MS }: { clock?: Clock; leaseMs?: number } = {},
  ) {
    this.clock = clock;
    this.leaseMs = leaseMs;
    const now = () => this.clock();
    this.store = new SqliteStore(path);
    this.repository = new JobRepository(this.store);
    this.ledger = new EventLedger(this.store, now);
    this.requests = new RequestStore(this.store, this.ledger, now);
    this.jobs = new JobService(this.store, this.repository, this.ledger, this.requests, now);
    this.leases = new LeaseService(this.store, this.repository, this.ledger, now, leaseMs);
    this.workers = new WorkerRegistry(this.store, this.ledger, now);
    this.experimentsService = new ExperimentService(
      this.store,
      this.jobs,
      this.ledger,
      this.requests,
      now,
    );
    this.queries = new QueryService(this.store, this.ledger, now, (id) => this.raw(id));
    this.retention = new RetentionService(this.store, now, () => this.queries.reportCache.clear());
  }
  // Low-level access stays available to local fault injection and storage tooling.
  get db() {
    return this.store.db;
  }
  close() {
    this.store.close();
  }
  transaction<T>(fn: () => T) {
    return this.store.transaction(fn);
  }
  readTransaction<T>(fn: () => T) {
    return this.store.readTransaction(fn);
  }
  metadata(name: string) {
    return this.store.metadata(name);
  }
  raw(id: string) {
    return this.repository.find(id);
  }
  event(type: string, jobId: string | null, data: JsonObject, now = this.clock()) {
    return this.ledger.append(type, jobId, data, now);
  }
  submit(input: unknown, requestKey: string) {
    return this.jobs.submit(input, requestKey);
  }
  transition(
    id: string,
    action: 'cancel' | 'replay',
    expectedRevision: number,
    requestKey: string,
    options: { clearFaults?: boolean } = {},
  ) {
    return this.jobs.transition(id, action, expectedRevision, requestKey, options);
  }
  setPaused(paused: boolean, requestKey: string) {
    return this.jobs.setPaused(paused, requestKey);
  }
  experiment(name: Scenario, requestKey: string) {
    return this.experimentsService.start(name, requestKey);
  }
  recover() {
    return this.leases.recover();
  }
  backoff(id: string, attempt: number) {
    return this.leases.backoff(id, attempt);
  }
  claim(workerId: string) {
    return this.leases.claim(workerId);
  }
  renew(id: string, workerId: string, token: number) {
    return this.leases.renew(id, workerId, token);
  }
  complete(id: string, workerId: string, token: number, result: JsonObject) {
    return this.leases.complete(id, workerId, token, result);
  }
  fail(id: string, workerId: string, token: number, error: unknown) {
    return this.leases.fail(id, workerId, token, error);
  }
  registerWorker(id: string, slot: number, pid: number) {
    return this.workers.register(id, slot, pid);
  }
  heartbeat(id: string, phase: 'idle' | 'busy' | 'paused', jobId: string | null = null) {
    return this.workers.heartbeat(id, phase, jobId);
  }
  stopWorker(id: string, reason = 'shutdown') {
    return this.workers.stop(id, reason);
  }
  detail(id: string) {
    return this.queries.detail(id);
  }
  experimentReport(id: string) {
    return this.queries.experimentReport(id);
  }
  experiments(limit = 8) {
    return this.queries.experiments(limit);
  }
  requestStatus(requestKey: string) {
    return this.requests.status(requestKey);
  }
  events(query: EventsQuery = {}) {
    return this.ledger.events(query);
  }
  snapshot(query: SnapshotQuery = {}) {
    return this.queries.snapshot(query);
  }
  diagnostics() {
    return new DiagnosticsService(this.store, this.ledger, () => this.clock()).inspect();
  }
  evidence() {
    return this.ledger.evidence();
  }
  prune(options: RetentionOptions = {}) {
    return this.retention.prune(options);
  }
}
