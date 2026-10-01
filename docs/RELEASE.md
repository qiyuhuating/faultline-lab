Faultline makes failure recovery visible: a real multi-process task engine plus an interactive, chain-verified trace player. This project is independent of yihe-health.

**Try the public replay:** https://qiyuhuating.github.io/faultline-lab/

The local application runs actual workers against SQLite WAL. Experiments cover SIGKILL recovery, bounded retries, durable deduplication, dead-letter replay, a stale worker actually attempting to commit, and an HTTP response deliberately lost after a durable write. The public page replays recorded evidence and labels it as recorded.

Acceptance: 48 core tests plus 57 browser checks across Chromium, Firefox and WebKit. This release is created only after its exact commit passes verification; the independent test ZIP preserves completed verification batches, including earlier failed runs. See docs/VERIFICATION.md for scope, failure history and screenshot-harness details.

Choose the appropriate asset:

- **faultline-source-v1.0.0.zip** — frontend and backend source, design decisions, API documentation, actual screenshots and resume/interview material. Contains no test set. Requires Node 24.x; run `npm start`.
- **faultline-tests-v1.0.0.zip** — test code, locked browser dependency and all collected test batches together. Extract alongside the source ZIP to merge `faultline/tests/`; run `npm test`.
- **faultline-web-v1.0.0.zip** — only the seven static player files, ready for static hosting. No backend or test set.
- **SHA256SUMS.txt** — archive checksums.
- **manifest.json** — exact verified commit and per-package file inventory.

Runtime dependencies: none. License: MIT. The transactional receipt guarantee applies to internal results, not arbitrary external side effects. Resume wording and a three-minute presentation are in docs/PORTFOLIO.md; technical discussion exercises are in docs/INTERVIEW.md.
