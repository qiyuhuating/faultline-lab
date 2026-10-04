v1.1.0 makes the reliable engine easier to maintain: Queue is now a 5.1 KB composition facade (down from 24.7 KB), and the entire backend is strict TypeScript.

Job persistence, transaction ownership, leases, experiments, event chaining, idempotent requests, queries, worker metadata and retention have explicit owners. All still share one connection and transaction boundary. Job state and write outcomes use discriminated unions; 12 negative compile contracts and an AST architecture gate guard future changes. Runtime database records remain validated separately.

Acceptance: 65 core tests plus 57 browser checks across Chromium, Firefox and WebKit; strict compilation, type contracts and formatting also pass before publication. Four new regressions cover v1.0.1 database compatibility, audit failure after receipt/state mutation, nested experiment rollback and invalid persisted leases. Original fault tests, older releases and historical evidence remain intact. See docs/VERIFICATION.md and ADR 005.

**Try the public recorded replay:** https://qiyuhuating.github.io/faultline-lab/

The local application runs real independent workers against SQLite WAL. The public page replays labeled original evidence. Faultline is independent of yihe-health.

Assets have distinct purposes:

- **faultline-source-v1.1.0.zip** — frontend and typed backend source, locked development tools, API/design/ADR documentation, real screenshots and resume/interview material. No test set. Node 24.15+ (24.x): run `npm start` without installing dependencies. For compiler/architecture checks, `npm ci --ignore-scripts && npm run check`.
- **faultline-tests-v1.1.0.zip** — core, HTTP, multi-process, three-browser and compile-only contract tests, plus all collected historical test batches together. Extract alongside source to merge `faultline/tests/`. Run `npm test`; install locked development tools for `npm run test:types`.
- **faultline-web-v1.1.0.zip** — seven deployable static replay files only. No backend, compiler or test set.
- **SHA256SUMS.txt** — SHA-256 archive checksums.
- **manifest.json** — the exact verified commit and per-package file inventory.

No runtime package dependencies. MIT License. Internal result receipts are atomic with successful state; arbitrary external side effects are outside this guarantee.
