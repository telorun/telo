---
description: "Test.Suite: discovers and runs test manifests in isolated kernel instances with result aggregation and path filtering"
sidebar_label: Test.Suite
---

# Test.Suite

> Examples below assume this module is imported with an `imports:` entry under alias `Test`. Kind references (`Test.Suite`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

Discovers and runs test manifests, aggregates results, and reports pass/fail. Replaces the bash test runner with a Telo-native mechanism.

Each test runs in an isolated `Kernel` instance with its own controllers, event bus, and evaluation context.

---

## Example

```yaml
kind: Telo.Application
metadata:
  name: TestSuite
variables:
  include:
    type: array
    items: { type: string }
    arg: include
    default: ["**/tests/*.yaml"]
  filter:
    type: string
    arg: { position: 0 }
    default: ""
imports:
  Test: ./modules/test
targets:
  - !ref RunAll
---
kind: Test.Suite
metadata:
  name: RunAll
include: !cel "variables.include"
exclude:
  - "**/__fixtures__/**"
filter: !cel "variables.filter"
```

Run all tests:

```
pnpm run test
```

Filter by name, or name the manifests to run:

```
pnpm run test run-sequence
pnpm run test --include modules/sql/tests/query.yaml --include 'modules/sqlite/tests/*.yaml'
```

---

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `include` | string[] | no | Glob patterns to discover test manifests. Resolved relative to this manifest's directory. Defaults to `["**/tests/*.yaml"]`. |
| `exclude` | string[] | no | Glob patterns to exclude. Defaults to `["**/__fixtures__/**"]`. |
| `filter` | string | no | Substring filter applied to discovered paths. An empty string filters nothing. |
| `concurrency` | integer | no | Maximum number of tests to run in parallel (minimum `1`). Defaults to `3` — small enough that Node's single JS thread isn't the bottleneck (which would inflate per-test wall-clock without meaningfully shortening the total), large enough to overlap I/O across a few tests. Each test still runs in its own isolated kernel. When more than one test is in the run, each test's stdout/stderr is buffered per-test and emitted only if the test fails (passing tests' output is dropped); single-test runs stream output live to the parent without buffering. |

## Command-line arguments

`Test.Suite` reads no command line of its own. Every field is evaluated at startup (`x-telo-eval: compile`), so the suite's APPLICATION decides which of them the command line may set: it declares a `variables:` entry bound with `arg:` and passes it to the field with `!cel "variables.<name>"`, as the example above does. `telo run ./test-suite.yaml --help` then lists what that suite accepts, and an argument it does not declare is refused before any test runs.

## Behaviour

1. Discovers test manifests by scanning the filesystem with `include`/`exclude` patterns.
2. Applies the `filter` substring, when one is set.
3. Runs up to `concurrency` tests in parallel (default `3`). Each test gets a fresh `Kernel` instance with `.env` file support (loads `.env` and `.env.local` from the test's directory).
4. Runs `kernel.load(testPath)` + `kernel.start()` on the child kernel.
5. When more than one test is in the run, captures the child kernel's stdout/stderr per-test and emits it only on failure (passing tests' output is dropped). Single-test runs stream output live to the parent without buffering.
6. Reports PASS/FAIL per test with timing **as each test completes** (so order is non-deterministic when `concurrency > 1`), and a summary at the end.
7. Exits non-zero if any test fails.

