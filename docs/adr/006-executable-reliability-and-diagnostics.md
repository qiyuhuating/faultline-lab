# ADR 006 — Executable reliability specifications and read-only diagnosis

Status: accepted, 2026-10-04. Introduced in v1.2.0.

## Problem

Individual regressions exercise important faults but do not explain whether combinations of cancellation, expired ownership, retry, replay and repeated requests agree with one consistent policy. A linked event log also says nothing about a missing success receipt. During this revision, deleting all events from the frozen v1.1.0 database reproduced a real defect: an empty chain was accepted even though the durable event sequence was 1.

## Decisions

### An independent state model

`tests/model/oracle.mjs` models policy without importing production transitions, repositories, SQL, retry helpers, serializers or evidence verification. A seeded runner operates two actual connections to one SQLite file, retains old captured lease tokens and completed generations, and checks every persisted job, attempt and receipt after each command.

Sixteen commands cover claim, renew, complete, fail, time advance, recovery, cancel, replay, pause, duplicate submission, content conflict, connection reopen, worker stop/replacement, repeated transition intent and new submission intent. Worker replacements receive distinct identities. New intents preserve old jobs in the model so earlier successful results remain subject to comparison.

The clock advances by 10 seconds, beyond the complete retry jitter window. Unique live priorities make selection independent of random UUIDs. This deliberately leaves exact jitter boundaries to the existing targeted tests. Normalized logical IDs and command traces give identical hashes for the same seed. A failure saves its complete command prefix and a one-seed reproduction command. Self-tests inject wrong renewal, completion and revision behavior and require the checker to reject it; a broken checker cannot silently pass those examples.

The release campaign executes 128 seeds × 256 commands = 32,768 transitions. This is bounded model-based testing, not exhaustive exploration or a formal proof. Interleavings within this runner are sequential; separate existing tests exercise four competing OS processes and actual lock contention.

### A semantic Doctor with no repair authority

`DiagnosticsService` reads one SQLite snapshot and checks physical pages, foreign keys, job/attempt lifecycle, current success receipts, historical winning attempts, persisted JSON, request records and the entire retained event chain. Samples are limited to 20 identifiers and omit task bodies, database paths and control tokens. Expired leases or stopped owners are warnings: observation must not manufacture recovery.

`npm run doctor -- /path/queue.sqlite --json` opens the existing database with native `readOnly: true`. It performs no schema initialization, migration, tick, retention, checkpoint or repair. A missing database is an error and does not create a file. `pass` and `warn` exit 0; `fail` or inability to inspect exits 1. Warnings remain visible in JSON and the console. The HTTP endpoint returns the same report with status 200 even when its domain verdict is fail. Manual UI inspection preserves the last valid report after a failed or malformed refresh.

Full diagnostic scans use bounded samples and streamed events, but still perform O(n) reads on the synchronous SQLite connection. They are explicit operator actions, never added to polling. Reports are point-in-time observations, not a promise that the next write will succeed.

### Retained-chain boundaries

New databases store `event_anchor_seq=0`. Prefix pruning atomically advances this exact sequence and the hash anchor. Verification checks sequence continuity, hashes, retained count and the durable head. A legitimate empty range has anchor sequence equal to head sequence; deletion of an unpruned tail fails.

Schema version remains 1. Opening an old database never invents or writes a boundary. GENESIS proves an unpruned zero boundary. A nonempty legacy pruned chain can infer its boundary from its first event, with an explicit `legacy-inferred` warning. An empty legacy pruned chain with an unknown boundary fails completeness verification. Later legitimate pruning can establish an exact stored boundary.

The portable v1 evidence format gains optional range metadata. Old nonempty public recordings remain readable. Neither range metadata nor hashes authenticate an administrator-controlled database: a writer can rewrite both. The result is an internal consistency check.

### A runnable live acceptance tool

`npm run verify:lab` starts an isolated database, real workers and a local controller. Seven fault scenarios run through HTTP. The tool additionally verifies dead-letter replay, cancellation while a worker is running, stale revision rejection, original request identities and event hashes after controller restart, and final semantic diagnosis. Lost responses use a read-only request lookup; POST is not automatically retried.

Each run gets its own output directory and retains its report on failure. The temporary application database and worker processes are cleaned up. This operator tool ships with source; independent model and browser test code remains exclusively in the test ZIP.

## Acceptance and limits

Fourteen diagnostic regressions, six model/checker tests and two verification-tool tests extend the 65-test baseline to 87. Three browser checks per engine cover valid diagnosis, malformed-refresh recovery and semantic corruption detection. Separate CI jobs retain the larger model campaign and live HTTP artifacts. Publication requires all six CI jobs on the exact source commit.

The original v1.1.0 defect reproduction and two early checker-fixture failures are preserved separately in batch 07. They are not passing acceptance runs. External side effects, cross-host HA, adversarial authenticity and physical disk failure remain outside this release's guarantees.

References: [Node 24.19 SQLite](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html), [SQLite transactions](https://sqlite.org/lang_transaction.html), [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs), [Temporal pre-production testing](https://github.com/temporalio/documentation/blob/main/docs/best-practices/pre-production-testing.mdx).
