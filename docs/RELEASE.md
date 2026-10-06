v1.2.5 corrects numeric summaries that lose small values between large cancelling numbers.

On v1.2.4, `1e12,0.000001,-1e12` produced zero while a different ordering produced a nonzero result. Summation now accumulates the parsed binary64 values exactly and rounds once to nearest, ties to even. Existing count, extrema, hash, numeric parsing and input limits remain unchanged; mean is the rounded sum divided by count. This is not arbitrary-precision decimal arithmetic and existing results/receipts are not rewritten.

Five failing-before regressions cover permutations, subnormal values, rounding ties, the 2,000-value boundary, an independent fixed-grid integer oracle and a real HTTP worker's durable result and receipt after restart. An optional Python Fraction cross-check of 256 cases is retained without adding a runtime dependency. Publication requires 116 core tests on Linux and Windows (one Linux descriptor-only assertion is skipped on Windows), 12 negative compile contracts, 32,768 independent model transitions, seven real-process HTTP fault scenarios with four supporting checks, and 84 checks across Chromium, Firefox and WebKit. The extracted source also starts and recovers a real worker crash. Failure history remains in the independent test archive.

The 500-task benchmark now prepares its backlog before starting four workers after Windows CI encountered a writer lock during overlapping submission. Counts, WAL/FULL, total deadline and integrity checks remain unchanged. Reports label the new submission mode; timings are not directly comparable to the previous workload.

**Recorded replay:** https://qiyuhuating.github.io/faultline-lab/

- **faultline-source-v1.2.5.zip** — frontend, strict TypeScript backend, Doctor, live HTTP verification tool and documentation. Node 24.15+ (24.x): `npm start`, without runtime dependencies. Compiler checks need `npm ci --ignore-scripts`.
- **faultline-tests-v1.2.5.zip** — independent model, core/process/HTTP/browser/type tests and all retained local/CI evidence. Extract alongside source to merge `faultline/tests/`, then run `npm test`.
- **faultline-web-v1.2.5.zip** — seven deployable static replay files.
- **SHA256SUMS.txt**, **manifest.json** — archive checksums, verified commit and file inventories.

Database schema v1 and historical recordings remain compatible. Doctor checks consistency without repair or authenticity claims; internal receipts do not guarantee arbitrary external exactly-once effects. MIT License.
