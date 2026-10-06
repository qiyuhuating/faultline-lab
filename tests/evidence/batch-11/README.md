# Batch 11 — v1.2.4 Unicode label persistence

Local runtime: Windows x64, Node 24.16.0, SQLite 3.53.0. Baseline is verified v1.2.3 at b6c40bc4c844ffd1a49f6858ebe7641a7297c2e0.

| Record | Meaning |
| --- | --- |
| `encoding-before.json` | Real HTTP returns 201 for lone high/low surrogates, but SQLite's indexed label becomes U+FFFD while JSON retains the surrogate. Doctor reports FAIL. Valid emoji/NUL controls remain consistent. |
| `before.tap` | Baseline: two rejection regressions fail; valid Unicode round-trip control passes. |
| `http-harness-before.tap`, `core-before-harness-fix.tap` | Initial fixed rejection tests pass but the HTTP positive check reads the response outside its documented `job` wrapper. Complete captures show the harness failure, not a passing gate. |
| `before-write-boundary.tap` | Rejecting surrogates in the shared definition reader blocks an existing legacy record. Three tests pass, legacy compatibility fails. |
| `unicode-final.tap` | All four final cases pass: six malformed patterns, no record/key changes, HTTP key reuse, valid Unicode/reopen and legacy work followed by healthy work. |
| `core-final.tap` | Full local acceptance: 111 tests, 110 passed, no failures, one Linux-only descriptor assertion skipped. |
| `process-drain.json`, `writer-lock-recovery.json` | Task-level four-process and writer-lock evidence from the final complete suite. |
| `static-check.log`, `type-contracts.log`, `format-check.log` | Strict compilation, architecture, 12 negative compile contracts and formatting pass. |
| `runtime.json`, `index.json` | Exact local versions and SHA-256 inventory of raw records. |

The final production change adds the Unicode guard to task insertion before the first write. Shared definition reading and legacy execution remain unchanged. Existing mismatched records keep Doctor FAIL without repair; the regression verifies they stay readable and claimable and do not block later healthy work. Well-formed surrogate pairs, 40 emoji at the existing 80-code-unit limit, embedded NUL, U+FFFD and multilingual labels remain valid. Neither stored records nor user inputs are silently rewritten.
