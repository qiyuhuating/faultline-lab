# Batch 06 — Queue decomposition and strict TypeScript

Date: 2026-10-04. All captures are actual local commands, before remote release verification.

- core-final.tap: complete 65-test TAP, 65 passed, zero failed/cancelled/skipped.
- static-check.log: JS syntax/frontend sinks, strict TypeScript and AST layer acceptance.
- type-contracts.log: 12 compile-only forbidden state/API cases, all expected compiler rejections enforced.
- format.log: new TypeScript source and compile fixtures pass pinned Prettier.
- runtime.json: exact local execution versions.
- benchmark-500.json: 500 tasks / 4 real processes; succeeded=receipts=attempts=500 and event chain valid. Executed concurrently with the core suite; not comparable to the earlier isolated benchmark and not a capacity claim.

Release CI separately reruns the full gates on the exact source commit. Browser screenshots/logs are retained in their own CI batch. Old batches are kept unchanged, including failed and partial captures; this batch does not rewrite them.
