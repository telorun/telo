---
description: "Test.Suite: discovers and runs test manifests in isolated kernel instances with result aggregation and CLI filtering"
sidebar_label: Test.Suite
---

# Test.Suite

> Examples below assume this module is imported with `Telo.Import` alias `Test`. Kind references (`Test.Suite`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

Discovers and runs test manifests, aggregates results, and reports pass/fail. Replaces the bash test runner with a Telo-native mechanism.

Each test runs in an isolated `Kernel` instance with its own controllers, event bus, and evaluation context.

---

## Example

```yaml
kind: Telo.Application
metadata:
  name: TestSuite
targets:
  - RunAll
---
kind: Telo.Import
metadata:
  name: Test
source: ./modules/test
---
kind: Test.Suite
metadata:
  name: RunAll
include:
  - "**/tests/*.yaml"
exclude:
  - "**/__fixtures__/**"
```

Run all tests:

```
pnpm run test
```

Filter by name:

```
pnpm run test run-sequence
pnpm run test -f run-sequence
pnpm run test --filter=run-sequence
```

---

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `include` | string[] | no | Glob patterns to discover test manifests. Resolved relative to this manifest's directory. Defaults to `["**/tests/*.yaml"]`. |
| `exclude` | string[] | no | Glob patterns to exclude. Defaults to `["**/__fixtures__/**"]`. |
| `filter` | string | no | Substring filter applied to discovered paths. Can also be passed via CLI args (see below). |
| `concurrency` | integer | no | Maximum number of tests to run in parallel (minimum `1`). Defaults to `3` — small enough that Node's single JS thread isn't the bottleneck (which would inflate per-test wall-clock without meaningfully shortening the total), large enough to overlap I/O across a few tests. Each test still runs in its own isolated kernel. When more than one test is in the run, each test's stdout/stderr is buffered per-test and emitted only if the test fails (passing tests' output is dropped); single-test runs stream output live to the parent without buffering. |

## CLI Arguments

The controller accepts CLI arguments passed after the manifest path:

| Flag | Alias | Type | Description |
|------|-------|------|-------------|
| `--filter` | `-f` | string | Filter tests by name substring |

Positional arguments are also accepted as a filter: `pnpm run test auth` filters to tests matching `auth`.

CLI args take precedence over the `filter` manifest field.

## Behaviour

1. Discovers test manifests by scanning the filesystem with `include`/`exclude` patterns.
2. Applies the filter (from `ctx.args`, positional arg, or manifest field).
3. Runs up to `concurrency` tests in parallel (default `3`). Each test gets a fresh `Kernel` instance with `.env` file support (loads `.env` and `.env.local` from the test's directory).
4. Runs `kernel.load(testPath)` + `kernel.start()` on the child kernel.
5. When more than one test is in the run, captures the child kernel's stdout/stderr per-test and emits it only on failure (passing tests' output is dropped). Single-test runs stream output live to the parent without buffering.
6. Reports PASS/FAIL per test with timing **as each test completes** (so order is non-deterministic when `concurrency > 1`), and a summary at the end.
7. Exits non-zero if any test fails.

## Kernel Arguments (`ctx.args`)

`Test.Suite` uses the kernel's controller argument system. Controllers can declare an `args` export that defines CLI flags with types and aliases:

```ts
export const args = {
  filter: { type: "string", alias: "f", description: "Filter tests by name" },
  verbose: { type: "boolean", alias: "v", description: "Show detailed output" },
};
```

The kernel parses `argv` using `util.parseArgs` against this spec and delivers the result via `ctx.args` in the controller's `create()` function. This mechanism is available to all controllers, not just `Test.Suite`.
