# ADR 004 — Storage failures and orderly shutdown

Status: accepted for v1.0.1. Database schema remains version 1; existing v1.0.0 data can be reopened.

## Lease time is evaluated after acquiring the write lock

A renewal's implicit UPDATE could wait behind another process for longer than the lease. Sampling time before that wait allowed an already expired owner to renew. Renewal now acquires BEGIN IMMEDIATE, then samples time and checks owner, token and deadline. A real child process holds the SQLite writer lock across the old deadline in the regression test.

## Persistence failure is distinct from computation failure

A handler error can become a business retry. Failure to persist a successfully computed result cannot. The worker leaves that lease for expiry and recovery, logs the infrastructure failure, and does not create a fictitious HANDLER_FAILED attempt. Lease expiry still consumes the bounded attempt budget; repeated infrastructure failure can therefore reach dead letter and requires explicit intervention.

SQLite may automatically roll back a transaction after SQLITE_FULL. Before an explicit rollback, inspect DatabaseSync.isTransaction. Preserve the primary error; if rollback itself fails, retain both errors and the primary cause. Tests set max_page_count on an actual database and trigger native error 13. This verifies SQLite page exhaustion, not a physical disk-full or power-loss fault.

HTTP maps native FULL to 507/STORAGE_FULL and BUSY/LOCKED to 503/STORAGE_BUSY. Reads can be retried with backoff. Writes remain explicit and use the original request key to resolve an uncertain result. An error response does not instruct the frontend to send another POST automatically.

## A response represents one database version

Standalone task detail now opens the same read transaction used by reports and snapshots. One detail cannot mix a running task with a new succeeded attempt or receipt from a concurrent commit. Retention invalidates cached reports even when it does not append an event.

Snapshot ETags are weak validators over observable response content, excluding only server-time annotations. Offline flags, renewed lease deadlines, metric/time-series changes, retention and proof verdicts all participate. Event revision plus worker timestamp was insufficient for changes that occur without an appended event.

## Shutdown owns completion

close() returns the same completion promise to all callers. It stops listening immediately, closes SSE, clears scheduling and asks workers to stop. A request already parsing its body rechecks shutdown before its write and gets 503/SHUTTING_DOWN with Connection: close. Database closure waits for HTTP and worker exits.

A nine-second timer force-closes remaining HTTP connections and kills remaining workers; synchronous database blocking can delay that timer, so it is not a hard real-time shutdown guarantee. Worker-stop metadata failures do not prevent database/IPC cleanup or crash the controller's exit callback. Failed port binding and post-listen initialization clean up their database and server resources.

## References

- [SQLite transaction error response](https://sqlite.org/lang_transaction.html#response_to_errors_within_a_transaction)
- [Node 24.19 SQLite transaction state](https://nodejs.org/download/release/v24.19.0/docs/api/sqlite.html#databaseistransaction)

Executable regression: tests/resilience.test.mjs. Original failing reproductions and the final core run are preserved together in tests/evidence/batch-05/.
