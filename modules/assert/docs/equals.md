---
description: "Assert.Equals: deep equality between an actual and an expected value, reporting each difference by its path"
sidebar_label: Assert.Equals
---

# Assert.Equals

> Examples below assume this module is imported with an `imports:` entry under alias `Assert`.

Compares `actual` against `expected` by deep equality (see the README for the rules) and fails with `ERR_ASSERTION_FAILED` when they differ.

```yaml
- name: config
  invoke: !ref Assert.equals
  inputs:
    actual: !cel "steps.load.result"
    expected: { server: { host: localhost, port: 8080 }, rows: [1, 2] }
```

## What a failure reports

A failure lists the differences, one line per difference, each with its path (`server.port`, `rows[1]`, `["key with space"]`):

| Difference | Line |
| --- | --- |
| a value differs | `server.port: expected 8080, got 80` |
| a key only `expected` holds | `server.tls: missing, expected true` |
| a key only `actual` holds | `server.debug: unexpected, got false` |
| a list's length differs | `rows: expected 2 items, got 4`, then one line per surplus item (`rows[2]: unexpected item 3`) or missing item (`rows[2]: missing item 3`) |

The elements both lists hold are compared position by position, each difference on its own line. Keys are visited in sorted order, and every value is written with its keys sorted, so the two sides read alike. An integer of any size is written as its digits. A value longer than 80 characters is cut with `…`, and after ten lines the rest is counted (`… and 4 more`).

With one difference the error's message is that line (`Assert.Equals "equals": server.port: expected 8080, got 80`); with several it is their count followed by the lines.

### Full values

Set `TELO_TEST_VERBOSE` to any non-empty value to have a failure also print the whole `expected` and `actual` values, uncut, beneath the lines, and a pass print the whole `actual` value. The error's message stays the difference list.

### Where the failure points

The error carries the place in its own `inputs` the first difference is about, as a JSON Pointer into `expected` — the differing node itself, or for something only `actual` holds, the nearest node of `expected` enclosing it (`/expected/rows` for a surplus item). `telo run` and a `Test.Suite` run turn it into the line and column of that node in the calling step's `inputs:`.

`Assert.Contains` and `Assert.Matches` point the same way: at `value` / `pattern` when the check fails, at `actual` when it is of a type the check cannot read.
