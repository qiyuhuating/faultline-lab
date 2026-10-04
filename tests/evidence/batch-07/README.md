# Batch 07 — v1.2.0 reliability specification and diagnosis

All repeated local files from this revision stay in this directory. Remote CI batches retain their own `ci-run-NNNN/` directories and original logs in the same independent test archive.

| File | Meaning |
| --- | --- |
| `deleted-tail-before-after.json` | Actual event-tail deletion defect on frozen v1.1.0 commit 6740453; old false pass and new rejection. This is the production defect reproduction. |
| `oracle-prototype-before.tap` | First checker run: one failed assertion because native SQLite rows have null prototypes. A harness defect, subsequently normalized; not an accepted run. |
| `early-gates-before.tap` | Early diagnostic/model fixtures: an invalid expectation about an administrator rewriting self-consistent anchors and the same row-prototype mismatch. These two fixture failures are retained honestly. |
| `final-package-and-fixtures.tap` | After the final packaging guard and formatting changes, the 22 relevant diagnostic/model/tool/package tests passed. |
| `core-final.tap` | Complete local final acceptance: 87 passed, zero failed/skipped. |
| `model-campaign.json` | All 128 seeded runs, 256 commands each, coverage and reproducible logical trace hashes: 32,768 passed transitions. |
| `model-campaign.log` | Operator output from that exact campaign. |
| `live-verification/` | Final v1.2.0 real-process HTTP run: seven scenarios, four supporting checks, chain export and semantic report. |
| `live-verification.log` | Console output from that complete run. |
| `static-check.log`, `type-contracts.log`, `format-check.log` | Strict compilation, architecture, negative compile contracts and formatting. |
| `format-write.log` | Formatting output, not a test result. |
| `source-only-smoke.log` | Extracted source has no test entries; real SIGKILL recovery, unique receipt and read-only diagnosis pass. |
| `runtime.json` | Exact local runtime versions. |
| `browser-environment-blocked.log` | Local browser invocation could not launch because Chromium was not installed. It is an environment failure, not a passing browser run. GitHub CI runs the full three-engine acceptance. |

The model smoke tests deliberately inject wrong return values and skipped revision checks to prove that the checker fails. Those are test doubles, not shipped production implementations. The larger model campaign is bounded sequential interleaving across real connections, not a claim of exhaustive concurrency verification.
