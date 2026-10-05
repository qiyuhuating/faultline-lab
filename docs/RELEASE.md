v1.2.2 rejects task metadata that disagrees with its persisted definition.

On v1.2.1, changing a task's kind, label, priority or retry budget could leave read-only Doctor at PASS even though the normalized JSON definition still described the original task. Doctor now checks all four relationships in its existing read snapshot. It samples only affected IDs, leaves every logical record unchanged and retains its response shape.

Four regressions fail before the fix and pass afterward. Publication requires 104 core tests on Linux and Windows (one Linux descriptor-only assertion is skipped on Windows), 12 negative compile contracts, 32,768 independent model transitions, seven real-process HTTP fault scenarios with four supporting checks, and 84 checks across Chromium, Firefox and WebKit. The extracted source package also starts and recovers a real worker crash. Failure history remains in the independent test archive.

**Recorded replay:** https://qiyuhuating.github.io/faultline-lab/

- **faultline-source-v1.2.2.zip** — frontend, strict TypeScript backend, Doctor, live HTTP verification tool and documentation. Node 24.15+ (24.x): `npm start`, without runtime dependencies. Compiler checks need `npm ci --ignore-scripts`.
- **faultline-tests-v1.2.2.zip** — independent model, core/process/HTTP/browser/type tests and all retained local/CI evidence. Extract alongside source to merge `faultline/tests/`, then run `npm test`.
- **faultline-web-v1.2.2.zip** — seven deployable static replay files.
- **SHA256SUMS.txt**, **manifest.json** — archive checksums, verified commit and file inventories.

Database schema v1 and historical recordings remain compatible. Doctor checks consistency without repair or authenticity claims; internal receipts do not guarantee arbitrary external exactly-once effects. MIT License.
