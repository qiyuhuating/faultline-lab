v1.2.4 prevents new task labels from changing during Unicode persistence.

On v1.2.3, an HTTP request with an unpaired UTF-16 surrogate in its label returned 201, but SQLite stored a replacement character while JSON retained the original surrogate. The newly created task then failed consistency diagnosis. New insertions now return VALIDATION before changing any record or reserving the request key.

Four regressions cover six malformed patterns through Queue and actual HTTP, reuse of a rejected request key, valid supplementary characters and the 80-code-unit limit, normalization/deduplication/reopen, and continued processing of a previously accepted legacy record followed by healthy work. Existing mismatched records still report FAIL without repair. Publication requires 111 core tests on Linux and Windows (one Linux descriptor-only assertion is skipped on Windows), 12 negative compile contracts, 32,768 independent model transitions, seven real-process HTTP fault scenarios with four supporting checks, and 84 checks across Chromium, Firefox and WebKit. The extracted source package also starts and recovers a real worker crash. Failure history remains in the independent test archive.

**Recorded replay:** https://qiyuhuating.github.io/faultline-lab/

- **faultline-source-v1.2.4.zip** — frontend, strict TypeScript backend, Doctor, live HTTP verification tool and documentation. Node 24.15+ (24.x): `npm start`, without runtime dependencies. Compiler checks need `npm ci --ignore-scripts`.
- **faultline-tests-v1.2.4.zip** — independent model, core/process/HTTP/browser/type tests and all retained local/CI evidence. Extract alongside source to merge `faultline/tests/`, then run `npm test`.
- **faultline-web-v1.2.4.zip** — seven deployable static replay files.
- **SHA256SUMS.txt**, **manifest.json** — archive checksums, verified commit and file inventories.

Database schema v1 and historical recordings remain compatible. Doctor checks consistency without repair or authenticity claims; internal receipts do not guarantee arbitrary external exactly-once effects. MIT License.
