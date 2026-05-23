# Test

Run Telo manifests as test suites. `Test.Suite` discovers `tests/*.yaml` cases, executes each in a fresh kernel, and reports pass/fail.

## Why use this

- **Tests are manifests** — a test case is a regular Telo file; the same kinds, scoping, and CEL rules apply.
- **Isolated runs** — every case gets its own kernel, so cross-test state pollution is impossible.
- **Composes with `Assert`** — pair `Test.Suite` with `Assert.Equals` / `Assert.Schema` / `Assert.Events` for behaviour-level checks.
- **CLI-friendly** — `pnpm run test` (or `telo test-suite.yaml`) drives the suite end-to-end.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Test.Suite` | Discover and run a set of test-case manifests, reporting pass/fail. |

## Example

```yaml
kind: Telo.Import
metadata: { name: Test }
source: std/test@latest
---
kind: Test.Suite
metadata: { name: All }
cases:
  - "modules/**/tests/*.yaml"
```

## Reference

- [`Test.Suite`](docs/suite.md)
