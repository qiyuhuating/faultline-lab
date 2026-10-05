# Batch 08 — v1.2.1 reports, recovery and Windows

This batch retains executed local regressions and acceptance on Windows x64, Node 24.16.0 / SQLite 3.53.0. GitHub's exact-commit Linux/Windows and three-engine records remain separately grouped by CI run in the release test archive.

| Record | Meaning |
| --- | --- |
| `baseline-core.tap` | Unmodified v1.2.0 on Windows: 87 tests, 83 passed, three failed, one Linux-only skip. Failures were the signal-name assertion, parent-death registry-phase assertion and an incorrect cleanup-hook order. |
| `cache-before.tap` | Four regressions before cache invalidation: cross-connection pruning, same/other connection eventless renewal and deleted receipt. All failed. |
| `semantic-before.tap` | Valid JSON with unreadable semantic definitions/errors, missing attempt history and unrelated report identity/receipt state fail their new tests before implementation changes. |
| `semantic-after.tap` | Those targeted diagnostic/proof/cache checks pass after their initial fixes. |
| `proof-current-token-before.tap` | A changed current job token still returned PASS before receipt/lease binding was added. |
| `ui-body-before.log`, `ui-body-after.log` | Real Chromium received 200 headers and an unfinished bootstrap body. Before: no timeout banner. After: the body deadline aborts and reports lost connectivity. |
| `ui-races-before.json` | Real browser observation: a delayed pending report overwrote a newer PASS; event keyboard selection moved focus to BODY. |
| `parent-death-probe.log` | Actual Windows worker PID exited after controller death while stored phase remained idle; heartbeat age correctly became offline. |
| `core-before-staging.tap` | Complete 100-test candidate run: one old one-attempt workload assertion failed although all 240 tasks succeeded with unique receipts. Claims were competing with synchronous submission setup. |
| `core-final.tap` | With backlog staged under pause, original strict one-attempt and receipt assertions retained: 100 tests, 99 passed, zero failed, one Linux-only descriptor skip. |
| `proof-process-final.tap` | Final affected subset after adding crash-evidence negatives: 14/14 pass, including real process deaths, eight Windows evidence mutations, eleven receipt/attempt mutations and original recording compatibility. |
| `model-campaign.json`, `model-campaign.log` | Independent policy model: 128 seeds × 256 steps, 32,768 transitions, all 16 command types exercised. |
| `live-verification/`, `live-verification.log` | Seven actual process/HTTP fault scenarios, four supporting checks, evidence chain and semantic diagnosis. |
| `browsers/` | Chromium, Firefox and WebKit each passed 18 dashboard, seven player and three real partial-body network checks. Includes JSON results, screenshots, lock and evidence. |
| `static-check.log`, `type-contracts.log`, `format-check.log` | Strict compilation, 19-module architecture, 12 negative contracts and formatting. Windows checkout now pins TypeScript files to LF. |
| `benchmark-500.json` | 500 real tasks, 500 receipts, 500 attempts and valid chain. Single-host measurement, not production capacity. |
| `runtime.json`, `index.json` | Exact local versions and SHA-256 inventory of the retained records. |

Local browser executables came from existing Windows Playwright caches through an untracked launch shim; their measured versions are in runtime.json. CI installs the browsers belonging to the locked test package independently. No environment failure is counted as a passing check. This batch disables Git text conversion so the raw files retain the exact bytes inventoried by index.json; failure-output whitespace is not reformatted.

The report cache also has two persistent regressions for the transaction rollback boundary: temporarily deleting a receipt must not leave a false failure after rollback, and temporarily restoring one must not leave a false pass. Calls within an existing transaction bypass the shared cache. The production event chain checks consistency, not resistance to an administrator rewriting self-consistent data.
