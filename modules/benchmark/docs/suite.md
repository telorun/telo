# Benchmark.Suite

Runs weighted scenarios against invocable resources inside the running process, in a closed loop: each of `concurrency` workers sends the next request when the previous one returns. Use it for thresholds in CI and for benchmarks that call resources directly. Latency is the time `invoke` takes; the loop is not corrected for stalls.

Percentiles come from the shared latency histogram (see [measurement](measurement.md)), so a long run uses the same memory as a short one, and a reported percentile is within 0.4% of the exact value.

## Errors

A request is an error when it throws, or when `validate` is not exactly `true`. Errors are grouped by code and message:

| Failure | Code | Message | Sample |
| --- | --- | --- | --- |
| A thrown error | its `code` when it has one, else its name | its message | its `data`, as JSON |
| `validate` not `true` | `VALIDATE_FALSE` | `validate returned false: status <status>` when the result has a `status`, else `validate returned false` | the result's `body` when it has one, else the result, as JSON |

## Report

JSON (`report.format: json`):

```json
{
  "Score": {
    "total": 31840, "rps": 1061.3, "p50": 8.9, "p95": 14.2, "p99": 21.7,
    "errors": {
      "count": 3,
      "rate": 0.0000942,
      "groups": [
        { "code": "VALIDATE_FALSE", "message": "validate returned false: status 500", "count": 3, "sample": "{\"code\":\"ERR_SQL_BUSY\"}" }
      ]
    }
  }
}
```

`total` counts every measured request once; `errors.rate` is `errors.count / total`. The table prints one row per scenario and, when any request failed, a second table of error groups (Scenario, Code, Count, Message, Sample).
