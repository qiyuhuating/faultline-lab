# v1.2.5 numerical summary evidence

Base: `9a8a9aeef55b7ee6268c901e4775bd4d2f29a028` (v1.2.4). Local acceptance uses Windows x64, Node 24.16.0 and SQLite 3.53.0; runtime.json retains exact versions.

- observations-before.json records frozen v1.2.4's order-dependent result and a trial compensated accumulator's spurious nonzero result for a balanced 2,000-value sequence. Neither trial is counted as acceptance.
- before.tap runs the final five regressions against that frozen handler: zero passed, five failed. summation-final.tap runs the corrected handler: all five passed.
- core-final.tap contains 116 tests: 115 passed, zero failed and one explicitly skipped Linux file-descriptor check. Static compilation/architecture, 12 negative compile contracts and formatting logs are separate.
- fraction-inputs.json and fraction-reference.json retain the optional Python Fraction oracle's 256 seeded cases of 96 values and the input digest. Reproduce with `python tests/summation-reference.py --node <Node 24 executable>`; Python is not a runtime/core-test dependency. The oracle sums exact rational representations of parsed floats, independently of the handler's bit decomposition.
- process-drain.json and writer-lock-recovery.json retain all task results, lease attempts, winning receipts and ordered events from the existing real-process regressions. Completion may legitimately require replacement leases; acceptance requires each unique correct result and the complete attempt/token history.
- ci-benchmark-before.log is original failed CI 37429774559: Linux and Windows core tests passed, but Windows' separate 500-task benchmark failed on a writer lock during overlapping bulk submission. benchmark-500.json is the revised local real-process run. The benchmark now stages its backlog before worker startup and labels that mode; it retains the workload, durability and integrity rules, with submission/startup/completion in the elapsed time. It does not claim to fix production writer contention or produce comparable historical timings.

The Node regressions cover 24 three-value permutations, rounding ties/subnormals, accepted and rejected limits, 128 seeds with four shuffles each against a fixed-grid integer oracle, and actual HTTP worker result/receipt persistence after restart. The fix rounds the exact sum of parsed binary64 inputs once; mean remains sum/count. Decimal parsing, old stored results, schema, count/min/max/hash and public recordings are unchanged.

index.json records original bytes and SHA-256 for every raw item. The collected CI directories retain exact-commit Linux/Windows, model, live-process and browser artifacts, along with previous failed runs. Raw TAP is deliberately not whitespace-normalized.
