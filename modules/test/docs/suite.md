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
3. For each test, creates a fresh `Kernel` instance with `.env` file support (loads `.env` and `.env.local` from the test's directory).
4. Runs `loadFromConfig()` + `start()` on the child kernel.
5. Captures stdout/stderr when running multiple tests (output only shown for failures or single-test runs).
6. Reports PASS/FAIL per test with timing, and a summary at the end.
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
