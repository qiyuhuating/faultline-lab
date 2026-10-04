v1.2.0 turns reliability claims into executable specifications and operator diagnostics.

An independent policy model checks 16 command types against actual SQLite jobs, attempts and receipts across two connections. Seeded traces are reproducible; mutation self-tests require the checker to detect invalid lease and revision behavior. A read-only Doctor inspects physical and semantic integrity without recovery or repair. Its CLI, HTTP report and accessible dialog share one contract.

This iteration also reproduces and fixes a v1.1.0 false pass after deleting the complete event tail. Exact retained-prefix and durable-head boundaries now detect missing history, while schema v1 and original public recordings remain compatible. Legacy uncertainty is explicit; the chain is a consistency check, not an authenticity signature.

Publication requires the exact commit to pass 87 core tests, 12 negative compile contracts, 32,768 model transitions, seven real HTTP/process fault scenarios with four supporting checks, and 66 browser checks across Chromium, Firefox and WebKit. A source-only extraction separately starts and recovers a real crashed worker. Full failure history and limits are in docs/VERIFICATION.md and ADR 006.

**Try the recorded replay:** https://qiyuhuating.github.io/faultline-lab/

The local application runs real independent workers; the public site replays the original labeled evidence. Faultline remains completely independent of yihe-health.

Assets have separate purposes:

- **faultline-source-v1.2.0.zip** — frontend, strict TypeScript backend, read-only Doctor, runnable live HTTP verification tool, locked compiler tools, API/design/ADR documentation and resume/interview material. No test set. Node 24.15+ (24.x): `npm start`, without installation or runtime dependencies. `npm run verify:lab` runs an isolated real fault campaign; `npm run doctor -- data/faultline.sqlite --json` inspects an existing database. Compiler checks need `npm ci --ignore-scripts`.
- **faultline-tests-v1.2.0.zip** — independent model/oracle, core, HTTP, multi-process, browser and negative compile tests, plus all collected historical batches and unsuccessful attempts together. Repeated files stay under their own batch directories. Extract alongside source to merge `faultline/tests/`; run `npm test` or the documented seeded campaign. No application source is substituted into this test package.
- **faultline-web-v1.2.0.zip** — seven deployable static replay files only. No backend, compiler or test set; use the source package to run new experiments.
- **SHA256SUMS.txt** — SHA-256 archive checksums.
- **manifest.json** — exact verified commit and per-package file inventories.

MIT License. Atomic internal receipts do not guarantee arbitrary external exactly-once effects. The bounded model is not formal verification; cross-host HA, physical disk faults and production deployment remain outside acceptance.
