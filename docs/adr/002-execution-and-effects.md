# ADR 002 — At-least-once execution; fenced internal commits

Status: accepted.

A process can finish computation and disappear before committing. Recovery therefore permits executing the computation again. Claiming a job grants a lease, not an everlasting right to write. Every claim advances a monotonic fencing token. The completion transaction checks state, owner, token and lease time before inserting the unique job/generation receipt and changing the job to succeeded.

The zombie experiment is intentionally stronger than killing a worker: the obsolete process remains alive, loses its lease, wakes after a new owner commits, and really calls complete. The rejected submission is recorded as commit.rejected.

The internal result receipt and state can be committed atomically. An external HTTP effect cannot join this SQLite transaction. External adapters would need receiver-side idempotency, an outbox/inbox protocol, and their own failure tests. This project makes no universal exactly-once claim.

A failed response is also ambiguous. The client looks up the original durable request key. If no confirmation can be read, it retains that key and tells the user the result is unknown. It does not automatically retry POST with a fresh key.
