# Release history

## v1.2.0 — 2026-10-04

- Add an independent seeded policy model with 16 commands, two SQLite connections, retained old leases, worker replacements, controller reopen and request replay. Check jobs, attempts and receipts after every command; preserve a reproducible failure prefix. Mutation self-tests prove the checker catches wrong lease and revision behavior.
- Add a read-only semantic Doctor, CLI, HTTP endpoint and accessible report dialog. Check pages, foreign keys, lifecycle, success receipts, winning attempts, persisted JSON, requests and the full retained chain; report expired ownership without repairing it.
- Reproduce and fix a v1.1.0 false pass when the entire event tail is deleted. Verify exact retained-prefix and durable-head sequences. Preserve schema v1 and old public recordings; label inferred legacy boundaries and reject an unknowable empty pruned range.
- Validate JSON result objects at the fenced commit boundary even for JavaScript callers.
- Ship a real-process HTTP acceptance tool covering seven fault scenarios, dead-letter replay, in-flight cancel/conflict, controller restart and final diagnostics. Keep model/browser fixtures in the independent test package.
- Extend CI with separate model and live-verification jobs and preserve all historical batches, including unsuccessful checker fixtures and blocked local browser launch.

Release gates: 87 core tests, 12 negative compile contracts, 32,768 model commands, seven live HTTP scenarios with four supporting checks, and 66 browser checks across three engines on the publishing commit. See ADR 006 and VERIFICATION.md for boundaries.

## v1.1.0 — 2026-10-04

- Split the 24,679-byte Queue into a 5,125-byte composition facade, persistence-only job repository, single transaction owner and focused job/lease/experiment/audit/query/retention services.
- Type-check the entire backend with strict TypeScript and discriminated job, outcome and transition contracts; run natively on Node 24 with no runtime package dependencies.
- Enforce dependency layers, acyclic runtime imports, no explicit any/type suppression and centralized transaction control via the TypeScript AST.
- Add 12 negative compile contracts and four behavioral regressions for legacy schema compatibility, cross-service audit rollback, nested experiment rollback and invalid persisted lease handling.
- Keep v1 database and HTTP contracts plus `.mjs` entry points compatible. Preserve all old test batches and separate source, test and static web archives.

Acceptance: 65 core tests, strict compile/type contracts and 57 browser checks on the exact releasing commit. See ADR 005 for scope and tradeoffs.

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
