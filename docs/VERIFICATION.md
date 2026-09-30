# Faultline v1.0.0 — verification record

Date: 2026-09-30. Scope: local task engine, HTTP API and source-level frontend checks.

## Completed gates

| Gate | Evidence | Result |
| --- | --- | --- |
| Input validation and persistence | Unknown fields, invalid types, oversize payloads; no failed write mutation | PASS |
| Durable idempotency | Two DB connections, three parallel HTTP requests, restart, content conflict | PASS |
| Fencing and lease recovery | Wrong owner/token, expired lease, cancellation, old completion after takeover | PASS |
| Transaction boundary | Receipt insert aborted by SQLite trigger; state and receipt rolled back together | PASS |
| Retry and dead letter | Budget, due time, jitter range, explicit replay generation and retained history | PASS |
| Process competition | 240 tasks / 4 independent OS processes, 240 receipts, one attempt per task | PASS |
| Real process crash | SIGKILL exit event; expired attempt then successful new owner; one receipt | PASS |
| Controller restart | Persistent task, pause state and request keys; rotated local control token | PASS |
| Hard controller death | Parent SIGKILL closes IPC; orphan workers stop claiming; new controller completes persisted work | PASS |
| HTTP boundary | Host/Origin/control token, body limit, malformed JSON, revision conflict | PASS |
| Observation | SSE cursor resume, ETag / 304, keyset pagination, event-chain tamper detection | PASS |
| Retention | Live task preserved; terminal history removed; retained-chain anchor valid | PASS |
| Source checks | JavaScript syntax; no frontend innerHTML, insertAdjacentHTML or eval sink | PASS |
| Source-only archive | Extracted source runs without test package; static files, HTTP numeric job and real crash recovery | PASS |

Automated core suite: **40 tests, 40 passed, 0 failed, 0 skipped**. Runtime: Node v24.19.0, SQLite 3.53.3, Linux x64. Reproduction: `node --test tests/*.test.mjs`.

Raw TAP is delivered in the independent test package, under `tests/evidence/batch-01/`. It comes from the final verification run; this document does not claim GitHub Actions have already run.

## Measured microbenchmark

Command: `node tools/benchmark.mjs --jobs=500 --output=benchmark-result.json`.

| Property | Measured value |
| --- | --- |
| Workers | 4 independent processes |
| Input workload | 500 tiny SHA-256 tasks, no external I/O, delayMs=0 |
| Submission time | 156 ms |
| Total submission + completion time | 714 ms |
| End-to-end local rate | 700.3 jobs/s |
| Succeeded / receipts / attempts | 500 / 500 / 500 |
| Event-chain consistency | Valid |
| SQLite mode | WAL, synchronous=FULL |
| Environment | Linux x64, Node 24.19.0, SQLite 3.53.3, 8 available CPUs |

Raw result: `docs/benchmarks/local-2026-09-30.json`. This single-host microbenchmark uses the in-process submission primitive and tiny pure computation. It is **not HTTP QPS, external delivery throughput, production capacity or a latency SLA**. Benchmark time includes worker startup and job submission; poll completion adds measurement granularity.

## Remaining verification

**Browser regression has not been executed in this environment.** Playwright is available as a test library, but its browser binaries are absent. Source syntax and unsafe-sink checks have run; they do not prove rendering or interaction correctness.

The delivered `tests/browser.mjs` and `.github/workflows/verify.yml` cover Chromium, Firefox and WebKit. The scripted checks include connection, dedupe, dead-letter replay, text-safe labels, filter switching, export, mobile overflow, offline draft recovery, JavaScript exceptions and CSP violations. Their presence is not a passing test result.

Before presenting it as browser-accepted: install the browser test dependency, run the browser suite, inspect desktop/mobile images and retain the JSON result. CI configuration is delivered, not published or executed on a remote repository.

## Practical boundaries

- No public hosting, accounts, tenant isolation or production deployment acceptance.
- No claim of arbitrary external exactly-once side effects or distributed HA.
- Local Host/Origin/control-token checks are not identity authentication.
- A database administrator can recompute the event chain; it checks consistency, not independent authenticity.
- Host clock adjustment, prolonged disk blocking, disk-full behavior and very large retained-event exports require additional targeted validation.

The project is ready for local engine demonstrations and further browser acceptance. Resume wording in `PORTFOLIO.md` only claims the completed gates above.
