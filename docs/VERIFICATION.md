# Faultline v1.2.0 — verification record

Updated 2026-10-04. Evidence includes local engine tests and actual GitHub Actions browser runs. The hosted site plays recorded traces; the downloadable application runs real worker processes.

## v1.2.0 specification and diagnostic acceptance

Local final acceptance is `tests/evidence/batch-07/core-final.tap`: **87 passed, zero failed/skipped** on Node 24.19.0 / SQLite 3.53.3. Strict compilation now covers 19 backend modules. Twelve negative compile contracts, AST architecture checks and formatting pass. The Queue remains a 5,309-byte composition facade; diagnostics have their own service rather than adding business logic to it.

| Gate | Executed evidence | Boundary |
| --- | --- | --- |
| Independent model | 128 seeds × 256 = 32,768 commands; all 16 command types exercised; per-run trace hashes | Two actual connections with sequential interleaving, not exhaustive parallel proof |
| Checker self-tests | Wrong stale renew/complete and bypassed revision are rejected; same seed and failed prefix reproduce | Tests of the checker, not production mutations |
| Read-only Doctor | 14 regressions: unchanged logical records, missing database, legacy schema, lost receipt, fake winner, lease warnings, JSON failures and report privacy | No repair/recovery/migration; O(n) manual inspection |
| Event-tail regression | Frozen v1.1.0 incorrectly accepts empty events at durable seq 1; revised version rejects | Consistency, not administrator-resistant authenticity |
| Live HTTP acceptance | Seven real-process scenarios plus dead replay, in-flight cancellation/conflict, controller restart and semantic diagnosis | Isolated local database and internal receipts |
| Diagnostic browser UI | Three additional checks per browser: valid read-only report/download, malformed refresh preserves report, semantic corruption reports FAIL | Existing application exception/CSP assertions include the new interactions |
| Publication | Core, model, live verification and three browser jobs must all pass on one exact commit | Source-only extracted crash recovery also required |

The full local campaign is `batch-07/model-campaign.json`; final v1.2.0 HTTP reports, chain export and diagnosis are in `batch-07/live-verification/`. All repeated attempts stay within that batch. The incomplete first model fixture used native SQLite null-prototype rows incorrectly; another early fixture incorrectly expected detection after an administrator rewrote a self-consistent anchor. Both were corrected and remain explicitly labeled test-harness failures. They are separate from the actual event-tail implementation defect.

A local browser launch could not run because Chromium was absent; its environment error is retained and is not counted as acceptance. GitHub installs and executes Chromium, Firefox and WebKit. Each engine runs **16 live checks + six static-player checks = 22**, for **66 total**. The release is created only after these exact-commit gates succeed, and its test archive collects original logs and digest-verified artifacts for every completed verification batch.

WebKit screenshot preparation creates three known inline-stylesheet diagnostics from live desktop/mobile/diagnostic captures and two from static-player captures. Application exception and CSP assertions run before captures; afterward each suite requires exactly its known count, with zero in Chromium/Firefox. Production CSP is unchanged. These are screenshot-tool artifacts, not waived application violations.

Reproduce the main new gates after merging source and tests:

```sh
npm ci --ignore-scripts
npm run check
npm run test:types
npm run format:check
npm test
npm run test:model -- --seed=1001 --seeds=128 --steps=256 --output=test-results/model/report.json
npm run verify:lab
npm run doctor -- data/faultline.sqlite --json
```

Doctor requires an existing database; start the application first if none exists. `verify:lab` creates and removes its own temporary database, retaining unique reports under test-results. Source contains the operator tools; the independent oracle and test fixtures remain in the test ZIP. See [ADR 006](adr/006-executable-reliability-and-diagnostics.md).

## Historical v1.1.0 architecture and type acceptance

The entire 17-module backend passes TypeScript 5.9.3 strict compilation. Twelve compile-only negative cases require rejection of ownerless/deadlineless running jobs, missing successful results, live leases in successful state, unreduced owners, incorrect write outcome fields, cancel/replay option confusion and invalid API commands. Removing an expected rejection fails compilation.

The AST gate checks dependency directions, runtime cycles, explicit any, type-check suppression, SQL-free Queue and centralized transaction control. Queue is 151 lines / 5,125 bytes; the largest extracted queue service is 6,472 bytes. Four new runtime tests prove the frozen v1.0.1 schema remains readable, an audit error rolls back receipt/state/attempt together, an experiment error rolls back nested deduplication and job creation, and invalid persisted leases are rejected without rewriting records. Full local TAP is `tests/evidence/batch-06/core-final.tap`: **65 passed, zero failed/skipped**.

CI reruns compiler, architecture, compile contracts, formatting, all core tests and 19 checks in each of three browsers on the exact publishing commit. The release extracts source without the independent test set, checks that source separately and runs a real process-crash recovery. CI logs and artifacts are collected with all prior batches by the release job. Original v1.0.1 results below remain as historical evidence.

## Historical v1.0.1 completed acceptance gates

| Gate | Executed evidence | Result |
| --- | --- | --- |
| Validation and persistence | Invalid types, unknown fields, oversize bodies; failed writes preserve records | PASS |
| Durable idempotency | Separate SQLite connections, three simultaneous HTTP submissions, restart and content conflicts | PASS |
| Fencing | Old owners, expired leases, cancellation and a real worker waking after takeover and submitting its result | PASS |
| Atomic internal effect | SQLite trigger aborts receipt insertion; receipt and successful state roll back together | PASS |
| Retry and replay | Budget, due time, jitter, dead letter, new generation and retained attempts | PASS |
| Independent processes | 240 tasks / 4 OS processes; 240 receipts and one attempt per task | PASS |
| Real crash and restart | SIGKILL, lease expiry, replacement owner, supervisor restart and parent-death IPC cleanup | PASS |
| Lost HTTP response | Durable write succeeds, socket closes before response; original request key confirms one job through GET | PASS |
| Consistent evidence | SQLite read transactions preserve a report snapshot while another connection commits | PASS |
| HTTP observation | Host/Origin/control-token checks, revision conflicts, ETag/304, SSE resume and bounded pagination | PASS |
| Retention and tampering | Live work retained, old history pruned with a valid anchor; modified chain rejected | PASS |
| Live dashboard | Three browsers: full reload draft, offline recovery, malformed snapshot recovery, replay, text-safe labels and mobile overflow | PASS |
| Public trace player | Three browsers: six verified traces, frame playback, stale commit, mobile layout and tamper stops playback | PASS |
| Source-only distribution | Extracted frontend/backend source starts without tests and recovers an actual SIGKILL experiment | PASS |

**v1.0.1 core: 61 tests passed, 0 failed, 0 skipped.** Historical local TAP is `tests/evidence/batch-05/core-final.tap`. Runtime: Node 24.19.0, SQLite 3.53.3, Linux x64. Reproduce with `node --test tests/*.test.mjs`.

**Browser baseline: 19 checks per browser × 3 = 57 passed checks.** Each browser ran 13 live-dashboard checks and six public-player checks. Chromium, Firefox and WebKit all passed in [verification run 36722199184](https://github.com/qiyuhuating/faultline-lab/actions/runs/36722199184), at commit `a98a9ee4bc4c6d9060e8bf88301f0ac8bfdaaf45`. Its core job passed too. Exact JSON results, runtime dependency locks and desktop/mobile PNGs are in the independent test ZIP. Final release automation requires its own verified commit to pass the same workflow again.

The live public page was deployed by [Pages run 36722505389](https://github.com/qiyuhuating/faultline-lab/actions/runs/36722505389) and inspected after deployment. It loads 45 recorded events, verifies their chain in WebCrypto and shows six experiments. `docs/media/` contains actual browser captures.

## Failure history is retained

| Batch | Outcome and corrective action |
| --- | --- |
| Local batch 01 | Earlier 40-test baseline and source-only smoke; superseded by expanded acceptance |
| CI run 36717526502 | WebKit screenshot harness triggered CSP; application policy remained strict |
| CI run 36719615396 | Chromium asserted an asynchronously loaded report too early; added a DOM-based wait. WebKit harness issue reproduced |
| CI run 36722199184 | Core plus all three browser jobs passed; exact downloaded artifacts retained as local batch 03 |
| Release verification | Raw TAP, runtime versions, screenshots, JSON and completed CI run metadata collected automatically into `ci-run-NNNN/` |

WebKit's Playwright screenshot preparation inserts an inline stylesheet even when animation synchronization is disabled. Both browser suites check application CSP errors **before** screenshots, then separately required exactly the two known stylesheet diagnostics from their two WebKit captures in the historical v1.0/v1.1 suites. Other browsers require zero. Application exceptions and application CSP failures remain failures; `unsafe-inline` was not added to production policy.

The release collector saves every completed main-branch verification batch up to the releasing run, including failed runs. An expired upstream artifact or evidence budget limit is recorded explicitly rather than fabricated. Each batch keeps its repeated files together. SHA-256 checksums and a per-package entry manifest accompany the three release ZIPs. Source contains frontend and backend; tests contain test code and evidence; web contains only the seven deployable player files.

## Measured microbenchmark

`node tools/benchmark.mjs --jobs=500 --output=benchmark-result.json`

| Property | Recorded local result |
| --- | --- |
| Workload | 500 tiny SHA-256 tasks, no external I/O, delayMs=0 |
| Workers | 4 independent processes |
| Submission / total elapsed | 156 ms / 714 ms |
| Local end-to-end rate | 700.3 jobs/s |
| Succeeded / receipts / attempts | 500 / 500 / 500 |
| Durability / chain | WAL, synchronous=FULL / valid |
| Environment | Node 24.19.0, SQLite 3.53.3, Linux x64, 8 available CPUs |

Original result: `docs/benchmarks/local-2026-09-30.json`. CI reruns retain their separate measurements. This is a single-host microbenchmark using the internal submission primitive and tiny computation, including worker startup and polling granularity. It is not HTTP QPS, external delivery capacity or a production SLA.

## Practical scope

The local control token is not account authentication. Internal receipts have a transactional guarantee; arbitrary external effects do not have an exactly-once guarantee. A database administrator can recompute the event chain. Distributed HA, tenant isolation, host clock jumps, physical filesystem-full injection and a production deployment are outside this release's acceptance scope.

## v1.0.1 destructive regression

Thirteen new tests pass locally: real writer lock spanning lease expiry; native SQLITE_FULL and recovery; consistent standalone detail; cache invalidation after pruning; conditional reads for offline/retention; concurrent shutdown; a body finishing during shutdown; port-binding cleanup; worker commit failure; HTTP storage-full and storage-busy responses; worker-stop cleanup failure. The release gate reruns 61 core tests and the three-browser suites on its exact commit.

Batch 05 keeps failures and successful reruns together. before-fix.tap and after-fix-partial.tap are incomplete early captures with no suite summary, not accepted test runs. before-worker-fix.tap independently reproduces the erroneous business retry; core-final.tap is the complete passing 61-test run. The machine-readable reproduction index states completeness explicitly. Native page exhaustion verifies SQLite capacity handling, not a complete filesystem or hardware failure.

The collector now retains original job logs and checks artifact SHA-256 digests, paginates beyond 100 runs and verifies the requested release commit against its successful run. The initial v1.0.0 CI core.tap contains the default human-readable reporter despite its extension; v1.0.1 explicitly selects TAP. Earlier raw local TAP and original CI logs remain available as recorded.
