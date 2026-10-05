# Batch 09 — v1.2.2 definition and indexed metadata

This focused patch follows the verified v1.2.1 release without changing its retained batch. Local runtime: Windows x64, Node 24.16.0, SQLite 3.53.0.

| Record | Meaning |
| --- | --- |
| `metadata-before.json` | Frozen v1.2.1 reports PASS after independently altering task kind, label, priority or retry budget while preserving the original JSON definition. |
| `before.tap` | All four new regressions fail against the old implementation. |
| `diagnostics-and-legacy.tap` | The fixed diagnostic and legacy architecture subset passes 26/26, with no logical writes and no private labels/text in the report. |
| `core-final.tap` | Complete sequential local acceptance: 104 tests, 103 passed, zero failed, one Linux-only descriptor assertion skipped. |
| `static-check.log`, `type-contracts.log`, `format-check.log` | Strict compilation, 19-module architecture, 12 negative contracts and formatting pass. |
| `runtime.json`, `index.json` | Exact local versions and SHA-256 inventory of raw retained records. |

The current `json-records` check compares kind, label, priority and maxAttempts with the normalized definition after readability validation. It keeps its bounded ID samples and report schema, changes no execution policy and performs no repair. Event hashes can remain valid despite this kind of metadata damage; neither this check nor the chain authenticates an administrator-controlled database. Remote acceptance is grouped separately in the release test archive's original CI batches.
