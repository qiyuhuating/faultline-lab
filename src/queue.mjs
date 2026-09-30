import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest, insist, jobDefinition, key, revision, DomainError } from './validation.mjs';
import { evaluateExperiment } from '../public/proof.mjs';

const STATES = ['queued', 'running', 'retry_wait', 'succeeded', 'dead', 'cancelled'];
const TERMINAL = new Set(['succeeded', 'dead', 'cancelled']);
export const LEASE_MS = 2400;

function serialize(row, details = false) {
  if (!row) return null;
  const result = {
    id: row.id, seq: row.seq, kind: row.kind, label: row.label, state: row.state,
    priority: row.priority, attempt: row.attempt, maxAttempts: row.max_attempts,
    generation: row.generation, revision: row.revision, token: row.lease_token,
    owner: row.lease_owner, leaseUntil: row.lease_until, runAt: row.run_at,
    createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at,
    error: row.last_error ? JSON.parse(row.last_error) : null,
    result: row.result ? JSON.parse(row.result) : null
  };
  if (details) result.definition = JSON.parse(row.definition);
  return result;
}

export class Queue {
  constructor(path, { clock = Date.now, leaseMs = LEASE_MS } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.clock = clock;
    this.leaseMs = leaseMs;
    this.reportCache = new Map();
    const meta = this.db.prepare("SELECT name FROM sqlite_master WHERE name='meta'").get();
    if (meta) {
      const version = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
      if (version?.value !== '1') {
        this.db.close();
        throw new Error('Unsupported schema; database left unchanged.');
      }
    }
    this.db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  }

  close() { this.db.close(); }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  readTransaction(fn) {
    if (this.reading) return fn();
    this.db.exec('BEGIN');
    this.reading = true;
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally { this.reading = false; }
  }

  metadata(name) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(name)?.value; }

  event(type, jobId, data, now = this.clock()) {
    const seq = Number(this.metadata('event_seq')) + 1;
    const last = this.db.prepare('SELECT hash FROM events ORDER BY seq DESC LIMIT 1').get();
    const previousHash = last?.hash ?? this.metadata('event_anchor');
    const encoded = canonical(data);
    const hash = digest(canonical({ seq, jobId, type, at: now, data: JSON.parse(encoded), previousHash }));
    this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)').run(seq, jobId, type, now, encoded, previousHash, hash);
    this.db.prepare("UPDATE meta SET value=? WHERE key='event_seq'").run(String(seq));
    return seq;
  }

  idempotent(operation, body, requestKey, fn) {
    key(requestKey);
    const fingerprint = digest(canonical({ operation, body }));
    const previous = this.db.prepare('SELECT * FROM requests WHERE key=?').get(requestKey);
    if (previous) {
      insist(previous.fingerprint === fingerprint, 'IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同请求。', 409);
      this.event('request.deduplicated', null, { operation });
      return { ...JSON.parse(previous.response), deduplicated: true };
    }
    const result = fn();
    this.db.prepare('INSERT INTO requests VALUES (?, ?, ?, ?)').run(requestKey, fingerprint, JSON.stringify(result), this.clock());
    return { ...result, deduplicated: false };
  }

  insertJob(definition) {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
    insist(count < 10000, 'CAPACITY', '实验库最多保留 10,000 个任务，请先执行保留策略或使用新的数据目录。', 429);
    const id = randomUUID();
    const now = this.clock();
    this.db.prepare(`INSERT INTO jobs
      (id, kind, label, definition, state, priority, max_attempts, run_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
      .run(id, definition.kind, definition.label, canonical(definition), definition.priority, definition.maxAttempts, now + definition.scheduleMs, now, now);
    this.event('job.created', id, { label: definition.label, kind: definition.kind, maxAttempts: definition.maxAttempts }, now);
    return id;
  }

  submit(input, requestKey) {
    const definition = jobDefinition(input);
    return this.transaction(() => this.idempotent('submit', definition, requestKey, () => ({ jobId: this.insertJob(definition) })));
  }

  experiment(name, requestKey) {
    insist(['retry', 'crash', 'duplicate', 'dead', 'burst', 'fence', 'response-loss'].includes(name), 'VALIDATION', '实验不存在。');
    return this.transaction(() => this.idempotent('experiment', { name }, requestKey, () => {
      const experimentId = randomUUID();
      const createdAt = this.clock();
      const startSeq = Number(this.metadata('event_seq'));
      const common = { text: 'Faultline / reproducible execution / 2026', delayMs: 700 };
      const definitions = {
        retry: { ...common, label: 'Transient failure · 自动重试', fault: { failFirst: 2 } },
        crash: { ...common, label: 'Process crash · 租约恢复', fault: { crashOnce: true } },
        fence: { ...common, label: 'Zombie worker · 旧提交拒绝', fault: { stallOnce: true } },
        'response-loss': { ...common, label: 'Lost response · 写入结果确认' },
        duplicate: { ...common, label: 'Repeated intent · 幂等去重' },
        dead: { ...common, label: 'Retry exhausted · 死信', maxAttempts: 3, fault: { failFirst: 10 } }
      };
      const ids = [];
      if (name === 'burst') {
        for (let i = 0; i < 24; i++) ids.push(this.insertJob(jobDefinition({ ...common, label: `Burst task ${String(i + 1).padStart(2, '0')}`, delayMs: 150 })));
      } else if (name === 'duplicate') {
        const definition = jobDefinition(definitions.duplicate);
        // Exercise the very same idempotency primitive three times, atomically.
        for (let i = 0; i < 3; i++) {
          const submitted = this.idempotent('submit', definition, `${digest(requestKey)}:inner`, () => ({ jobId: this.insertJob(definition) }));
          ids.push(submitted.jobId);
        }
      } else ids.push(this.insertJob(jobDefinition(definitions[name])));
      const jobIds = [...new Set(ids)];
      this.db.prepare('INSERT INTO experiments VALUES (?, ?, ?, ?, ?, ?)').run(experimentId, name, createdAt, startSeq, JSON.stringify(jobIds), ids.length);
      this.event('experiment.started', null, { experimentId, name, submissions: ids.length, uniqueJobs: jobIds.length });
      return { experimentId, jobIds, submissions: ids.length };
    }));
  }

  raw(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); }

  backoff(id, attempt) {
    const jitter = parseInt(digest(`${id}:${attempt}`).slice(0, 6), 16) / 0xffffff;
    return Math.round(Math.min(6000, 500 * 2 ** (attempt - 1)) * (0.8 + jitter * 0.4));
  }

  expire(now) {
    const expired = this.db.prepare("SELECT * FROM jobs WHERE state='running' AND lease_until<=?").all(now);
    for (const job of expired) {
      const dead = job.attempt >= job.max_attempts;
      const error = { code: 'LEASE_EXPIRED', message: 'Worker 未在租约内完成或续约。' };
      this.db.prepare(`UPDATE attempts SET state='expired', ended_at=?, error=?
        WHERE job_id=? AND generation=? AND number=? AND state='running'`)
        .run(now, JSON.stringify(error), job.id, job.generation, job.attempt);
      this.db.prepare(`UPDATE jobs SET state=?, lease_owner=NULL, lease_until=NULL,
        run_at=?, updated_at=?, revision=revision+1, completed_at=?, last_error=? WHERE id=?`)
        .run(dead ? 'dead' : 'retry_wait', now + this.backoff(job.id, job.attempt), now, dead ? now : null, JSON.stringify(error), job.id);
      this.event('lease.expired', job.id, { workerId: job.lease_owner, token: job.lease_token, attempt: job.attempt, nextState: dead ? 'dead' : 'retry_wait' }, now);
    }
    return expired.length;
  }

  recover() { return this.transaction(() => this.expire(this.clock())); }

  claim(workerId) {
    return this.transaction(() => {
      const now = this.clock();
      this.expire(now);
      const worker = this.db.prepare('SELECT * FROM workers WHERE id=?').get(workerId);
      insist(worker && worker.phase !== 'stopped', 'WORKER_UNKNOWN', 'Worker 未注册。', 409);
      if (this.metadata('paused') === 'true') return null;
      // BEGIN IMMEDIATE serializes competing claimers across independent processes.
      const job = this.db.prepare(`SELECT * FROM jobs WHERE state IN ('queued','retry_wait')
        AND run_at<=? AND attempt<max_attempts ORDER BY priority DESC, run_at, seq LIMIT 1`).get(now);
      if (!job) return null;
      const token = job.lease_token + 1;
      const number = job.attempt + 1;
      this.db.prepare(`UPDATE jobs SET state='running', attempt=?, lease_token=?, lease_owner=?,
        lease_until=?, updated_at=?, revision=revision+1 WHERE id=?`).run(number, token, workerId, now + this.leaseMs, now, job.id);
      this.db.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(job.id, job.generation, number, workerId, token, 'running', now, null, null);
      this.db.prepare("UPDATE workers SET phase='busy', job_id=?, last_seen=? WHERE id=?").run(job.id, now, workerId);
      this.event('lease.claimed', job.id, { workerId, token, attempt: number, generation: job.generation }, now);
      return serialize(this.raw(job.id), true);
    });
  }

  owns(job, workerId, token, now) {
    return job?.state === 'running' && job.lease_owner === workerId && job.lease_token === token && job.lease_until > now;
  }

  renew(id, workerId, token) {
    const now = this.clock();
    const updated = this.db.prepare(`UPDATE jobs SET lease_until=? WHERE id=? AND state='running'
      AND lease_owner=? AND lease_token=? AND lease_until>?`).run(now + this.leaseMs, id, workerId, token, now);
    return updated.changes === 1;
  }

  complete(id, workerId, token, result) {
    return this.transaction(() => {
      const now = this.clock();
      const job = this.raw(id);
      if (!this.owns(job, workerId, token, now)) {
        if (job) this.event('commit.rejected', id, { workerId, token, currentToken: job.lease_token, currentState: job.state, reason: 'STALE_LEASE' }, now);
        return { accepted: false, reason: 'STALE_LEASE' };
      }
      const encoded = canonical(result);
      // The built-in result receipt and state change commit in one transaction.
      this.db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?, ?)').run(id, job.generation, token, encoded, now);
      this.db.prepare(`UPDATE attempts SET state='succeeded', ended_at=? WHERE job_id=? AND generation=? AND number=?`).run(now, id, job.generation, job.attempt);
      this.db.prepare(`UPDATE jobs SET state='succeeded', result=?, completed_at=?, updated_at=?,
        lease_owner=NULL, lease_until=NULL, revision=revision+1 WHERE id=?`).run(encoded, now, now, id);
      this.event('job.succeeded', id, { workerId, token, attempt: job.attempt, generation: job.generation, resultHash: digest(encoded) }, now);
      return { accepted: true };
    });
  }

  fail(id, workerId, token, error) {
    return this.transaction(() => {
      const now = this.clock();
      const job = this.raw(id);
      if (!this.owns(job, workerId, token, now)) return { accepted: false, reason: 'STALE_LEASE' };
      const dead = job.attempt >= job.max_attempts;
      const safeError = { code: String(error.code ?? 'HANDLER_FAILED').slice(0, 60), message: String(error.message ?? '任务处理失败').slice(0, 200) };
      const runAt = now + this.backoff(id, job.attempt);
      this.db.prepare(`UPDATE attempts SET state='failed', ended_at=?, error=? WHERE job_id=? AND generation=? AND number=?`).run(now, JSON.stringify(safeError), id, job.generation, job.attempt);
      this.db.prepare(`UPDATE jobs SET state=?, last_error=?, run_at=?, updated_at=?, completed_at=?,
        lease_owner=NULL, lease_until=NULL, revision=revision+1 WHERE id=?`)
        .run(dead ? 'dead' : 'retry_wait', JSON.stringify(safeError), runAt, now, dead ? now : null, id);
      this.event(dead ? 'job.dead' : 'job.retry_scheduled', id, { attempt: job.attempt, generation: job.generation, workerId, token, error: safeError, retryAt: dead ? null : runAt }, now);
      return { accepted: true, state: dead ? 'dead' : 'retry_wait' };
    });
  }

  transition(id, action, expectedRevision, requestKey, { clearFaults = false } = {}) {
    revision(expectedRevision);
    insist(['cancel', 'replay'].includes(action), 'VALIDATION', '操作不受支持。');
    insist(typeof clearFaults === 'boolean', 'VALIDATION', 'clearFaults 必须是布尔值。');
    return this.transaction(() => this.idempotent('transition', { id, action, expectedRevision, clearFaults }, requestKey, () => {
      const job = this.raw(id);
      insist(job, 'NOT_FOUND', '任务不存在。', 404);
      insist(job.revision === expectedRevision, 'REVISION_CONFLICT', '任务已变化，请读取最新版本再操作。', 409);
      const now = this.clock();
      if (action === 'cancel') {
        insist(!TERMINAL.has(job.state), 'INVALID_TRANSITION', '终态任务不能取消。', 409);
        if (job.state === 'running') this.db.prepare("UPDATE attempts SET state='cancelled', ended_at=? WHERE job_id=? AND generation=? AND number=?").run(now, id, job.generation, job.attempt);
        this.db.prepare(`UPDATE jobs SET state='cancelled', completed_at=?, updated_at=?, revision=revision+1,
          lease_token=lease_token+1, lease_owner=NULL, lease_until=NULL WHERE id=?`).run(now, now, id);
      } else {
        insist(['dead', 'cancelled'].includes(job.state), 'INVALID_TRANSITION', '只有死信或已取消的任务可以重放。', 409);
        insist(job.generation < 20, 'REPLAY_LIMIT', '每个任务最多重放 20 次，请创建新任务。', 409);
        const definition = JSON.parse(job.definition);
        if (clearFaults) definition.fault = { failFirst: 0, crashOnce: false, stallOnce: false };
        this.db.prepare(`UPDATE jobs SET state='queued', generation=generation+1, attempt=0,
          revision=revision+1, lease_token=lease_token+1, lease_owner=NULL, lease_until=NULL,
          completed_at=NULL, result=NULL, last_error=NULL, run_at=?, updated_at=?, definition=? WHERE id=?`)
          .run(now, now, canonical(definition), id);
      }
      this.event(`job.${action === 'cancel' ? 'cancelled' : 'replayed'}`, id, { previousState: job.state, previousRevision: job.revision, clearFaults, generation: action === 'replay' ? job.generation + 1 : job.generation }, now);
      return { jobId: id, revision: job.revision + 1 };
    }));
  }

  setPaused(paused, requestKey) {
    insist(typeof paused === 'boolean', 'VALIDATION', 'paused 必须是布尔值。');
    return this.transaction(() => this.idempotent('pause', { paused }, requestKey, () => {
      this.db.prepare("UPDATE meta SET value=? WHERE key='paused'").run(String(paused));
      this.event(paused ? 'queue.paused' : 'queue.resumed', null, { paused });
      return { paused };
    }));
  }

  registerWorker(id, slot, pid) {
    this.transaction(() => {
      const now = this.clock();
      this.db.prepare('INSERT INTO workers VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, slot, pid, 'idle', null, now, now);
      this.event('worker.started', null, { workerId: id, slot, pid }, now);
    });
  }

  heartbeat(id, phase, jobId = null) {
    this.db.prepare("UPDATE workers SET last_seen=?, phase=?, job_id=? WHERE id=? AND phase!='stopped'").run(this.clock(), phase, jobId, id);
  }

  stopWorker(id, reason = 'shutdown') {
    this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM workers WHERE id=?').get(id);
      if (!existing || existing.phase === 'stopped') return;
      this.db.prepare("UPDATE workers SET phase='stopped', last_seen=? WHERE id=?").run(this.clock(), id);
      this.event('worker.stopped', existing.job_id, { workerId: id, reason });
      // A stopped worker's job is intentionally recovered by lease expiry.
    });
  }

  detail(id) {
    const job = serialize(this.raw(id), true);
    if (!job) throw new DomainError('NOT_FOUND', '任务不存在。', 404);
    job.attempts = this.db.prepare('SELECT * FROM attempts WHERE job_id=? ORDER BY generation, number').all(id);
    job.receipts = this.db.prepare('SELECT generation, token, committed_at FROM receipts WHERE job_id=? ORDER BY generation').all(id);
    job.events = this.events({ jobId: id, limit: 500 });
    return job;
  }

  experimentReport(id) {
    return this.readTransaction(() => {
    const stamp = `${this.metadata('event_seq')}:${Math.floor(this.clock() / 1000)}`;
    const cached = this.reportCache.get(id);
    if (cached?.stamp === stamp) return cached.report;
    const row = this.db.prepare('SELECT * FROM experiments WHERE id=?').get(id);
    if (!row) throw new DomainError('NOT_FOUND', '实验不存在或已超过保留期限。', 404);
    const jobIds = JSON.parse(row.job_ids);
    const jobs = jobIds.map(jobId => this.detail(jobId));
    const experiment = { id, scenario: row.scenario, createdAt: row.created_at, startSeq: row.start_seq, submissions: row.submissions, jobIds };
    const report = { experiment, jobs, verdict: evaluateExperiment(experiment, jobs, this.clock()), serverTime: this.clock() };
    this.reportCache.set(id, { stamp, report });
    if (this.reportCache.size > 16) this.reportCache.delete(this.reportCache.keys().next().value);
    return report;
    });
  }

  experiments(limit = 8) {
    return this.db.prepare('SELECT id FROM experiments ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit).map(row => {
      const report = this.experimentReport(row.id);
      return { ...report, jobs: report.jobs.map(job => ({ id: job.id, state: job.state, generation: job.generation, revision: job.revision })) };
    });
  }

  requestStatus(requestKey) {
    key(requestKey);
    const row = this.db.prepare('SELECT response FROM requests WHERE key=?').get(requestKey);
    return { found: Boolean(row), result: row ? JSON.parse(row.response) : null, serverTime: this.clock() };
  }

  events({ after = 0, jobId = null, limit = 100, newest = false } = {}) {
    let rows;
    if (jobId) rows = this.db.prepare('SELECT * FROM events WHERE job_id=? ORDER BY seq DESC LIMIT ?').all(jobId, limit).reverse();
    else if (newest) rows = this.db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?').all(limit).reverse();
    else rows = this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit);
    return rows.map(row => ({ seq: row.seq, jobId: row.job_id, type: row.type, at: row.at, data: JSON.parse(row.data), previousHash: row.previous_hash, hash: row.hash }));
  }

  snapshot({ state = '', before = Number.MAX_SAFE_INTEGER, limit = 40 } = {}) {
    return this.readTransaction(() => {
    insist(state === '' || STATES.includes(state), 'VALIDATION', '状态筛选无效。');
    insist(Number.isSafeInteger(before) && before > 0, 'VALIDATION', '分页游标无效。');
    const rows = state ? this.db.prepare('SELECT * FROM jobs WHERE state=? AND seq<? ORDER BY seq DESC LIMIT ?').all(state, before, limit + 1)
      : this.db.prepare('SELECT * FROM jobs WHERE seq<? ORDER BY seq DESC LIMIT ?').all(before, limit + 1);
    const counts = Object.fromEntries(STATES.map(s => [s, 0]));
    for (const row of this.db.prepare('SELECT state, COUNT(*) n FROM jobs GROUP BY state').all()) counts[row.state] = row.n;
    const now = this.clock();
    const workers = this.db.prepare('SELECT * FROM workers ORDER BY last_seen DESC, started_at DESC LIMIT 8').all().map(w => ({ ...w, online: w.phase !== 'stopped' && now - w.last_seen < 3000 }));
    const recent = this.db.prepare("SELECT COUNT(*) n, AVG(ended_at-started_at) avg FROM attempts WHERE state='succeeded' AND ended_at>?").get(now - 60000);
    const series = [];
    const start = Math.floor(now / 10000) * 10000 - 110000;
    for (let i = 0; i < 12; i++) {
      const at = start + i * 10000;
      const sample = this.db.prepare("SELECT COUNT(*) n FROM attempts WHERE state='succeeded' AND ended_at>=? AND ended_at<?").get(at, at + 10000);
      series.push({ at, completed: sample.n });
    }
    const jobs = rows.slice(0, limit).map(row => serialize(row));
    return {
      serverTime: now, revision: Number(this.metadata('event_seq')), paused: this.metadata('paused') === 'true',
      jobs, counts, workers, nextBefore: rows.length > limit ? jobs.at(-1).seq : null,
      metrics: { completedLastMinute: recent.n, averageExecutionMs: Math.round(recent.avg ?? 0), receipts: this.db.prepare('SELECT COUNT(*) n FROM receipts').get().n, deduplicated: this.db.prepare("SELECT COUNT(*) n FROM events WHERE type='request.deduplicated'").get().n },
      series, events: this.events({ newest: true, limit: 12 }),
      experiments: this.experiments()
    };
    });
  }

  evidence() {
    return this.readTransaction(() => {
    const events = this.events({ limit: 60000 });
    const anchor = this.metadata('event_anchor');
    let previousHash = anchor;
    let previousSeq = null;
    let valid = true;
    for (const event of events) {
      const expected = digest(canonical({ seq: event.seq, jobId: event.jobId, type: event.type, at: event.at, data: event.data, previousHash: event.previousHash }));
      if (event.previousHash !== previousHash || event.hash !== expected || (previousSeq !== null && event.seq !== previousSeq + 1)) valid = false;
      previousHash = event.hash;
      previousSeq = event.seq;
    }
    if (events.length && previousSeq !== Number(this.metadata('event_seq'))) valid = false;
    return { format: 'faultline-evidence-v1', generatedAt: this.clock(), integrity: { valid, count: events.length, anchor, head: previousHash }, events };
    });
  }

  prune({ days = 30, maxEvents = 50000 } = {}) {
    return this.transaction(() => {
      const cutoff = this.clock() - days * 86400000;
      const removed = this.db.prepare("DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE state IN ('succeeded','dead','cancelled') AND completed_at<? LIMIT 500)").run(cutoff).changes;
      this.db.prepare('DELETE FROM requests WHERE created_at<?').run(cutoff);
      this.db.prepare("DELETE FROM experiments WHERE created_at<? OR EXISTS (SELECT 1 FROM json_each(experiments.job_ids) j WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE id=j.value))").run(cutoff);
      this.db.prepare("DELETE FROM workers WHERE phase='stopped' AND last_seen<?").run(cutoff);
      const head = Number(this.metadata('event_seq'));
      const candidates = this.db.prepare('SELECT seq, at, hash FROM events ORDER BY seq LIMIT 5000').all();
      let last = null;
      for (const row of candidates) {
        if (row.at >= cutoff && row.seq > head - maxEvents) break;
        last = row;
      }
      let removedEvents = 0;
      if (last) {
        removedEvents = this.db.prepare('DELETE FROM events WHERE seq<=?').run(last.seq).changes;
        this.db.prepare("UPDATE meta SET value=? WHERE key='event_anchor'").run(last.hash);
      }
      return { removedJobs: removed, removedEvents };
    });
  }
}
