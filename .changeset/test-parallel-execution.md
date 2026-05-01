---
"@telorun/test": minor
---

`Test.Suite` now runs tests in parallel. Each test still runs in its own isolated `Kernel`; the suite drives a worker pool that pulls from the discovered queue. New optional `concurrency` field on the `Test.Suite` schema (integer, minimum `1`) controls the pool size; defaults to `3` (small enough that Node's single JS thread isn't the bottleneck, large enough to overlap I/O across a few tests). Set to `1` to restore the previous strictly-sequential behaviour. Per-test PASS/FAIL is printed as each test finishes, so result order is no longer guaranteed when `concurrency > 1`.
