PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta VALUES ('schema_version', '1'), ('paused', 'false'), ('event_seq', '0'), ('event_anchor', 'GENESIS');
CREATE TABLE IF NOT EXISTS jobs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  definition TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','running','retry_wait','succeeded','dead','cancelled')),
  priority INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  lease_token INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until INTEGER,
  run_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  last_error TEXT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(state, run_at, priority DESC, seq);
CREATE INDEX IF NOT EXISTS jobs_expired ON jobs(state, lease_until);
CREATE INDEX IF NOT EXISTS jobs_history ON jobs(state, seq DESC);
CREATE TABLE IF NOT EXISTS attempts (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  number INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  token INTEGER NOT NULL,
  state TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  error TEXT,
  PRIMARY KEY(job_id, generation, number)
);
CREATE TABLE IF NOT EXISTS receipts (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  token INTEGER NOT NULL,
  result TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  PRIMARY KEY(job_id, generation)
);
CREATE TABLE IF NOT EXISTS requests (
  key TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  slot INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  phase TEXT NOT NULL,
  job_id TEXT,
  started_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  job_id TEXT,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_job ON events(job_id, seq DESC);
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  scenario TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  start_seq INTEGER NOT NULL,
  job_ids TEXT NOT NULL,
  submissions INTEGER NOT NULL
);
