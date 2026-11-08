# Measurement core

Every figure the module reports comes from four shared parts. They hold no Telo concept, so a worker thread can use them.

## Latency histogram

Latencies are recorded into a fixed-size log-linear histogram (microsecond buckets, 128 sub-buckets per power of two), so memory does not grow with the number of requests and recording never sorts or allocates.

- **Range:** 1 microsecond to about 19 hours. A larger value is counted in the top bucket.
- **Precision:** a reported percentile is within 0.4% of the exact value (half a bucket), plus 1 microsecond of rounding at the low end. Values below 256 microseconds are exact to the microsecond. The minimum and maximum are exact, and a percentile is never reported outside them.
- **Percentile rule:** the p-th percentile is the value at rank `ceil(p x count)` in sorted order.
- **Merging:** a histogram serializes to plain data (`count`, `minUs`, `maxUs`, `sumUs`, sparse `buckets`) that crosses a thread boundary, and histograms merge by adding bucket counts. The merge of per-thread histograms equals one histogram that recorded everything.

## Error groups

Failures are grouped by `code` and `message`, each group keeping its count and a sample of the first failure. At most 20 distinct groups are kept; further distinct failures are counted in one `OTHER` group. Messages and samples are cut to 300 characters, so memory stays bounded however many failures occur. Groups merge by adding counts, in the same bounded way.

The report record is `errors: { count, rate, groups: [{ code, message, count, sample }] }`, where `rate` is `count` over the requests measured.

## Spread

A timing figure measured over several samples is reported as `{ median, min, max, cv }`: the median of all samples, the extremes, and the coefficient of variation (sample standard deviation over the mean; 0 for one sample or a zero mean). Spread is recorded, never used to discard a run.

## Where each kind uses them

`Benchmark.Suite` records into one histogram and one set of error groups per scenario on the thread it runs on. `Benchmark.Comparison`'s load generator threads each record into their own and post them, as plain data, to the main thread, which merges them; nothing a thread records grows with the run. See [comparison](comparison.md) for the open-loop latency pass and the throughput pass built on them.
