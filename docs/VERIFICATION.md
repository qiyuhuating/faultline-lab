# Faultline v1.0.0 — verification record

Updated 2026-10-01. Evidence includes local engine tests and actual GitHub Actions browser runs. The hosted site plays recorded traces; the downloadable application runs real worker processes.

## Completed acceptance gates

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

**Core: 48 tests passed, 0 failed, 0 skipped.** Latest local TAP is `tests/evidence/batch-02/core-run-final.tap`. Runtime: Node 24.19.0, SQLite 3.53.3, Linux x64. Reproduce with `node --test tests/*.test.mjs`.

**Browsers: 19 checks per browser × 3 = 57 passed checks.** Each browser ran 13 live-dashboard checks and six public-player checks. Chromium, Firefox and WebKit all passed in [verification run 36722199184](https://github.com/qiyuhuating/faultline-lab/actions/runs/36722199184), at commit `a98a9ee4bc4c6d9060e8bf88301f0ac8bfdaaf45`. Its core job passed too. Exact JSON results, runtime dependency locks and desktop/mobile PNGs are in the independent test ZIP. Final release automation requires its own verified commit to pass the same workflow again.

The live public page was deployed by [Pages run 36722505389](https://github.com/qiyuhuating/faultline-lab/actions/runs/36722505389) and inspected after deployment. It loads 45 recorded events, verifies their chain in WebCrypto and shows six experiments. `docs/media/` contains actual browser captures.

## Failure history is retained

| Batch | Outcome and corrective action |
| --- | --- |
| Local batch 01 | Earlier 40-test baseline and source-only smoke; superseded by expanded acceptance |
| CI run 36717526502 | WebKit screenshot harness triggered CSP; application policy remained strict |
| CI run 36719615396 | Chromium asserted an asynchronously loaded report too early; added a DOM-based wait. WebKit harness issue reproduced |
| CI run 36722199184 | Core plus all three browser jobs passed; exact downloaded artifacts retained as local batch 03 |
| Release verification | Raw TAP, runtime versions, screenshots, JSON and completed CI run metadata collected automatically into `ci-run-NNNN/` |

WebKit's Playwright screenshot preparation inserts an inline stylesheet even when animation synchronization is disabled. Both browser suites check application CSP errors **before** screenshots, then separately require exactly the two known stylesheet diagnostics from their two WebKit captures. Other browsers require zero. Application exceptions and application CSP failures remain failures; `unsafe-inline` was not added to production policy.

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

The local control token is not account authentication. Internal receipts have a transactional guarantee; arbitrary external effects do not have an exactly-once guarantee. A database administrator can recompute the event chain. Distributed HA, tenant isolation, host clock jumps, disk-full injection and a production deployment are outside this release's acceptance scope.
