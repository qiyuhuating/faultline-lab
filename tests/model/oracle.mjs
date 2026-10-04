// Deliberately independent of Queue internals: no repository, SQL, backoff helper,
// serialization, event verifier or production state transition code is imported.
export class Oracle {
  constructor(leaseMs) {
    this.leaseMs = leaseMs;
    this.now = 1700000000000;
    this.jobs = [];
    this.paused = false;
    this.stopped = new Set();
  }
  add(id, priority) {
    this.jobs.push({
      id,
      priority,
      state: 'queued',
      attempt: 0,
      generation: 0,
      revision: 1,
      token: 0,
      owner: null,
      leaseUntil: null,
      completedAt: null,
      result: null,
      ready: true,
      attempts: [],
      receipts: [],
    });
    return this.jobs.at(-1);
  }
  advance() {
    this.now += 10000;
    for (const job of this.jobs) if (job.state === 'retry_wait') job.ready = true;
  }
  owns(job, claim) {
    return (
      job.state === 'running' &&
      job.owner === claim.worker &&
      job.token === claim.token &&
      job.leaseUntil > this.now
    );
  }
  end(job, state) {
    const attempt = job.attempts.at(-1);
    attempt.state = state;
    attempt.endedAt = this.now;
    job.owner = null;
    job.leaseUntil = null;
    job.revision++;
  }
  expire() {
    let count = 0;
    for (const job of this.jobs)
      if (job.state === 'running' && job.leaseUntil <= this.now) {
        this.end(job, 'expired');
        job.state = job.attempt === 3 ? 'dead' : 'retry_wait';
        job.completedAt = job.state === 'dead' ? this.now : null;
        job.ready = false;
        count++;
      }
    return count;
  }
  claim(worker) {
    // A failed claim transaction cannot commit lease expiry as a side effect.
    if (this.stopped.has(worker)) return { error: 'WORKER_UNKNOWN' };
    this.expire();
    const job = this.paused
      ? null
      : this.jobs
          .filter((j) => ['queued', 'retry_wait'].includes(j.state) && j.ready)
          .sort((a, b) => b.priority - a.priority)[0];
    if (!job) return { value: null };
    job.state = 'running';
    job.attempt++;
    job.token++;
    job.revision++;
    job.owner = worker;
    job.leaseUntil = this.now + this.leaseMs;
    job.completedAt = null;
    job.attempts.push({
      generation: job.generation,
      number: job.attempt,
      worker,
      token: job.token,
      state: 'running',
      startedAt: this.now,
      endedAt: null,
    });
    return { value: { id: job.id, token: job.token, worker } };
  }
  renew(claim) {
    const job = this.jobs.find((j) => j.id === claim.id);
    const accepted = this.owns(job, claim);
    if (accepted) job.leaseUntil = this.now + this.leaseMs;
    return accepted;
  }
  complete(claim) {
    const job = this.jobs.find((j) => j.id === claim.id);
    if (!this.owns(job, claim)) return { accepted: false, reason: 'STALE_LEASE' };
    this.end(job, 'succeeded');
    job.state = 'succeeded';
    job.completedAt = this.now;
    job.result = { model: true };
    job.receipts.push({ generation: job.generation, token: claim.token, committed_at: this.now });
    return { accepted: true };
  }
  fail(claim) {
    const job = this.jobs.find((j) => j.id === claim.id);
    if (!this.owns(job, claim)) return { accepted: false, reason: 'STALE_LEASE' };
    this.end(job, 'failed');
    job.state = job.attempt === 3 ? 'dead' : 'retry_wait';
    job.completedAt = job.state === 'dead' ? this.now : null;
    job.ready = false;
    return { accepted: true, state: job.state };
  }
  transition(id, action, expectedRevision) {
    const job = this.jobs.find((job) => job.id === id);
    if (job.revision !== expectedRevision) return { error: 'REVISION_CONFLICT' };
    if (action === 'cancel') {
      if (['succeeded', 'dead', 'cancelled'].includes(job.state))
        return { error: 'INVALID_TRANSITION' };
      if (job.state === 'running') {
        const attempt = job.attempts.at(-1);
        attempt.state = 'cancelled';
        attempt.endedAt = this.now;
      }
      job.state = 'cancelled';
      job.owner = null;
      job.leaseUntil = null;
      job.completedAt = this.now;
      job.token++;
      job.revision++;
    } else {
      if (!['dead', 'cancelled'].includes(job.state)) return { error: 'INVALID_TRANSITION' };
      if (job.generation >= 20) return { error: 'REPLAY_LIMIT' };
      job.state = 'queued';
      job.generation++;
      job.attempt = 0;
      job.revision++;
      job.token++;
      job.owner = null;
      job.leaseUntil = null;
      job.completedAt = null;
      job.result = null;
      job.ready = true;
    }
    return { value: { jobId: job.id, revision: job.revision, deduplicated: false } };
  }
}
