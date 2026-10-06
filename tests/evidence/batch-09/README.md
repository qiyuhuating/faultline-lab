# Batch 09 — v1.2.2 definition and indexed metadata

This focused patch follows the verified v1.2.1 release without changing its retained batch. Local runtime: Windows x64, Node 24.16.0, SQLite 3.53.0.

| Record | Meaning |
| --- | --- |
| `metadata-before.json` | Frozen v1.2.1 reports PASS after independently altering task kind, label, priority or retry budget while preserving the original JSON definition. |
| `before.tap` | All four new regressions fail against the old implementation. |
| `diagnostics-and-legacy.tap` | The fixed diagnostic and legacy architecture subset passes 26/26, with no logical writes and no private labels/text in the report. |
| `core-final.tap` | Earlier complete acceptance of the definition patch: 104 tests, 103 passed, zero failed, one Linux-only descriptor assertion skipped. |
| `core-lease-final.tap` | Final acceptance including real writer-lock recovery: 105 tests, 104 passed, zero failed, one Linux-only descriptor assertion skipped. |
| `ci-37313762328-failed.log` | Original Windows CI failure: 240 tasks and unique receipts completed, but a legitimate second attempt violated the incidental one-attempt expectation. |
| `process-harness-before.tap`, `process-final.tap` | First revised harness rejected SQLite's null-prototype row despite equal receipt fields; after explicit field comparison all six process tests pass. |
| `process-drain.json`, `writer-lock-recovery.json` | Real four-process job/attempt/receipt history and ordinary-task recovery after an actual writer lock spans lease expiry. |
| `static-check.log`, `type-contracts.log`, `format-check.log` | Strict compilation, 19-module architecture, 12 negative contracts and formatting pass. |
| `runtime.json`, `index.json` | Exact local versions and SHA-256 inventory of raw retained records. |

The current `json-records` check compares kind, label, priority and maxAttempts with the normalized definition after readability validation. It keeps its bounded ID samples and report schema, changes no execution policy and performs no repair. Event hashes can remain valid despite this kind of metadata damage; neither this check nor the chain authenticates an administrator-controlled database. Remote acceptance is grouped separately in the release test archive's original CI batches.

The 240-job assertion checks each independently calculated SHA-256 result, consecutive attempts and tokens, matching expiry events and exactly one receipt tied to the winning attempt and completion time. Four distinct starting process IDs and multiple actual owners remain required. The added lock test uses no task fault flags and requires an expired attempt, one successful replacement and rejection of the old token. The production lease duration, task count and process count are unchanged. `static-lease-check.log` records strict compilation and architecture after the harness change.
