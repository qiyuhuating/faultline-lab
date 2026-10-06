# Release history

## v1.2.5 — 2026-10-06

- Fix numeric summaries that lose small residuals between large cancelling values. Accumulate the parsed binary64 inputs as integer multiples of 2^-1074 and round once to nearest, ties to even; preserve count/min/max/hash and existing input limits.
- Add five failing-before regressions covering input permutations, subnormal values, rounding boundaries, the 2,000-value limit, an independent fixed-grid oracle and a real HTTP worker's receipt/result after restart. Preserve balanced zero and ordinary decimal Number semantics.
- Retain an optional Python rational cross-check of 256 cases spanning exponents -1074 through 39. Neither Python nor a new package is required by the server or core tests. Existing successful results and receipts are not rewritten.

## v1.2.4 — 2026-10-06

- Reject ill-formed Unicode task labels at the insertion boundary before any record is written. Previously an HTTP-accepted lone surrogate was replaced by SQLite while remaining escaped in the JSON definition, creating a task that immediately failed consistency diagnosis.
- Preserve valid emoji, supplementary characters, embedded NUL, the replacement character and normalized request replay. Require rejected HTTP requests to reserve no request key and allow that key to submit valid content afterward.
- Keep legacy definitions readable and claimable; existing mismatched records remain diagnostic failures without repair. Four regressions retain the original failures, positive round trips and a legacy task followed by healthy work.

## v1.2.3 — 2026-10-06

- Keep malformed event JSON at FAIL while replacing its parser exception with a fixed, content-free diagnostic message. JavaScript parse errors can include the private input that caused them.
- Add failing-before regressions for direct/CLI diagnosis and the real HTTP endpoint. Require no private event content and no logical database writes; preserve the existing report shape.

## v1.2.2 — 2026-10-06

- Make read-only Doctor reject task kind, label, priority or retry budget that disagrees with its persisted normalized JSON definition. Valid JSON and an unchanged event chain alone cannot establish this consistency.
- Add four failing-before regressions that preserve every database record during inspection and require diagnostics to expose no original or altered labels or task text.
- Verify all 240 four-process results, complete lease histories and unique winning receipts, including legitimate expired leases. Add a real writer-lock recovery regression without task fault flags and retain job-level evidence.

The task engine, schema and report shape are unchanged. Exact-commit release gates retain Linux/Windows core, independent model, live faults and all three browser engines; local reproduction is retained in batch-09.

## v1.2.1 — 2026-10-05

- Invalidate experiment reports after writes from either SQLite connection, including renewals and retention without an event. Bypass shared report caching inside existing transactions so rolled-back data cannot retain a false pass or failure.
- Make Doctor reject semantically invalid persisted job definitions, unreadable error records, missing attempts, incorrect current counters and attempts from future generations. Keep diagnostics read-only and report only affected IDs.
- Require portable experiment reports to contain the exact expected job IDs, lifecycle-compatible receipts and a receipt matching the current fencing token.
- Keep the browser's request deadline active until the JSON body is consumed. Confirm a committed but incomplete POST response through its durable request key without issuing a duplicate write.
- Reject stale report and detail responses after closing and reopening the same item. Preserve keyboard focus when selecting events in the static trace player.
- Record an injected crash request and the controller's actual observed exit. Require both matching records for Windows' exit-code evidence while retaining Linux SIGKILL and original recordings.
- Add Windows to core CI and run partial-response recovery checks in Chromium, Firefox and WebKit. Verify parent death by actual process exit and offline state on Windows; retain the Linux descriptor-only test as an explicit skip there.

Source, independent tests and static web assets remain separate. Schema v1 and historical recordings are preserved; full acceptance and recorded failures are in VERIFICATION.md and batch-08.

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
