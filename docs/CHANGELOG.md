# Release history

## v1.0.1 — 2026-10-04

Fixes identified by destructive regression, with no database-schema change:

- Reject renewal when the lease expires while waiting on another process's SQLite writer lock.
- Preserve native SQLITE_FULL after automatic transaction rollback; expose explicit storage-full/busy HTTP codes.
- Keep persistence failures separate from handler failures; allow lease-based recovery of an uncommitted result.
- Read standalone task details consistently and invalidate report caches after retention.
- Validate conditional snapshots against actual observable content, including offline transitions and retention.
- Stop accepting work at shutdown, reject incomplete writes before mutation, await one shared close operation and clean up failed startup/worker-stop paths.
- Pin the CI output to the TAP reporter and retain core evidence even on failure.
- Collect all paginated CI batches, original job logs and verified artifact digests in the independent test package.

Local core acceptance: 61 passed, zero failed/skipped. The release workflow reruns the core suite and all three browser engines on the exact releasing commit before creating assets. See VERIFICATION.md and ADR 004 for evidence and remaining operational boundaries.

## v1.0.0 — 2026-10-01

Initial independent task engine and public, chain-verified replay player. Six real experiments, durable idempotency, fenced result receipts, bounded retry/dead-letter replay, HTTP/SSE dashboard and separate source/test/web delivery.

Acceptance: 48 core tests and 57 browser checks across Chromium, Firefox and WebKit. The original tagged release remains available.
