# Batch 10 — v1.2.3 malformed-event diagnostic privacy

Local runtime: Windows x64, Node 24.16.0, SQLite 3.53.0. This patch follows the exact-commit verified v1.2.2 release without changing its raw evidence.

| Record | Meaning |
| --- | --- |
| `privacy-before.json` | Frozen v1.2.2 emits the synthetic private marker in Doctor's parser error. |
| `before.tap` | Both direct/CLI and actual HTTP privacy regressions fail before the production fix; complete 2-test run. |
| `before-interrupted.tap` | Earlier red run shows both leaks but has no suite summary; stopped after its fixture cleanup kept another SQLite connection open. Not accepted as a complete run. |
| `diagnostics-final.tap` | All 24 diagnostic cases pass, including failure status, no input exposure and unchanged logical records. |
| `core-final.tap` | Full local suite: 107 tests, 106 passed, no failures, one Linux-only descriptor assertion skipped. |
| `process-drain.json`, `writer-lock-recovery.json` | Retained task-level results from this complete suite; same four-process and actual writer-lock contracts as v1.2.2. |
| `static-check.log`, `type-contracts.log`, `format-check.log` | Strict compiler, architecture, 12 negative contracts and formatting pass. |
| `runtime.json`, `index.json` | Local versions and SHA-256 inventory of raw records. |

The event-chain failure keeps its existing evidence shape and uses a fixed message, preventing JavaScript's parse exception from quoting persisted private contents. This does not repair data, turn malformed events into PASS or establish administrator-resistant authenticity. Corrected HTTP fixture cleanup closes its sole application connection before removing the temporary directory. Original incomplete and failed records remain separate from accepted evidence.
