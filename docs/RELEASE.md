v1.2.3 keeps private malformed event content out of diagnostics.

On v1.2.2, an event containing invalid JSON could expose its private contents through JavaScript's parser exception in Doctor and the HTTP diagnostic endpoint. Unreadable events still produce FAIL, with a fixed diagnostic message that contains no parser input. Reports remain read-only and retain their existing shape.

Two regressions fail before the fix and pass afterward, covering direct/CLI diagnosis and real HTTP responses without logical database writes. Publication requires 107 core tests on Linux and Windows (one Linux descriptor-only assertion is skipped on Windows), 12 negative compile contracts, 32,768 independent model transitions, seven real-process HTTP fault scenarios with four supporting checks, and 84 checks across Chromium, Firefox and WebKit. The four-process workload still checks all 240 results, complete lease histories and unique winning receipts. The extracted source package also starts and recovers a real worker crash. Failure history remains in the independent test archive.

**Recorded replay:** https://qiyuhuating.github.io/faultline-lab/

- **faultline-source-v1.2.3.zip** — frontend, strict TypeScript backend, Doctor, live HTTP verification tool and documentation. Node 24.15+ (24.x): `npm start`, without runtime dependencies. Compiler checks need `npm ci --ignore-scripts`.
- **faultline-tests-v1.2.3.zip** — independent model, core/process/HTTP/browser/type tests and all retained local/CI evidence. Extract alongside source to merge `faultline/tests/`, then run `npm test`.
- **faultline-web-v1.2.3.zip** — seven deployable static replay files.
- **SHA256SUMS.txt**, **manifest.json** — archive checksums, verified commit and file inventories.

Database schema v1 and historical recordings remain compatible. Doctor checks consistency without repair or authenticity claims; internal receipts do not guarantee arbitrary external exactly-once effects. MIT License.
