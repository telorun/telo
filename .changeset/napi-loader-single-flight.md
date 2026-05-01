---
"@telorun/kernel": patch
---

Fix segfault when multiple kernels concurrently load the same `pkg:cargo` controller crate. The napi controller loader's process-wide module cache only protected sequential callers — two parallel `kernel.start()` calls (e.g. tests running in parallel) could both miss the cache, both run `cargo build`, and both `fs.copyFile` over the same `<libname>.node` while one had already mmapped it, racing napi finalize callbacks and crashing Node with SIGSEGV. Concurrent loads for the same crate now share a single in-flight build promise; late arrivals await it and read the populated module cache when it resolves.
