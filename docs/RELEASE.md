v1.2.1 fixes false verification results and browser recovery failures, with Linux and Windows core acceptance.

Experiment reports now invalidate after eventless writes on either SQLite connection and never cache uncommitted outer-transaction data. Doctor detects invalid persisted definitions and attempt history. Portable reports require the expected job IDs and current receipt token. These cases have failing-before, passing-after regressions.

The dashboard keeps its request deadline through JSON consumption, so incomplete bootstrap, snapshot and committed POST bodies recover. A lost write response is confirmed by its durable request key without a duplicate POST. Reopening the same report or detail rejects older responses; static event selection preserves keyboard focus.

Windows crash evidence requires an actual controller-observed exit and a matching earlier crash-request record. Linux SIGKILL and six historical public recordings remain compatible. CI runs core tests on both operating systems, three browser engines, compiler/type/architecture/format gates, 32,768 model transitions and seven real-process HTTP faults with four supporting checks. Publication additionally starts and crash-tests the extracted source package. Raw failures and final counts are in docs/VERIFICATION.md and tests/evidence/batch-08.

**Try the recorded replay:** https://qiyuhuating.github.io/faultline-lab/

The local application runs independent workers; the public site replays the original labeled evidence. Database schema v1 is unchanged.

Assets have separate purposes:

- **faultline-source-v1.2.1.zip** — frontend, strict TypeScript backend, read-only Doctor, real HTTP verification tool, locked compiler tools and documentation. No test set. Node 24.15+ (24.x): `npm start` without installation or runtime dependencies. Compiler checks need `npm ci --ignore-scripts`.
- **faultline-tests-v1.2.1.zip** — independent model, core/process/HTTP/browser tests, negative compile contracts and historical local/CI evidence. Extract alongside source to merge `faultline/tests/`, then run `npm test`. Source implementation stays in the source package.
- **faultline-web-v1.2.1.zip** — seven deployable static replay files.
- **SHA256SUMS.txt** — archive checksums.
- **manifest.json** — verified commit and per-package file inventories.

MIT License. Atomic internal receipts do not guarantee arbitrary external exactly-once effects. The bounded model is not formal verification; the event chain establishes consistency, not third-party authenticity.
