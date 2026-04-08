---
sidebar_label: Assert.Manifest
---

# Assert.Manifest

Runs the static analyzer on a target manifest file and asserts on the diagnostics it produces. Use this to test that the analyzer correctly catches errors (negative tests) or produces no false positives (positive tests).

---

## Example: expect a specific error

```yaml
kind: Assert.Manifest
metadata:
  name: TestBadFieldAccess
source: ./__fixtures__/bad-type-access.yaml
expect:
  errors:
    - code: CEL_UNKNOWN_FIELD
      message: nonExistent
```

## Example: expect zero errors

```yaml
kind: Assert.Manifest
metadata:
  name: TestCleanManifest
source: ./__fixtures__/valid-manifest.yaml
expect:
  errors: []
```

---

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | string | yes | Relative path to the manifest file to analyze. Resolved from the declaring module's location. |
| `expect.errors` | array | yes | Expected analysis errors. Empty array `[]` asserts that zero errors are produced. |
| `expect.errors[].code` | string | no | Diagnostic code to match (e.g. `CEL_UNKNOWN_FIELD`, `UNRESOLVED_REFERENCE`). |
| `expect.errors[].message` | string | no | Substring to match in the diagnostic message. |

## Behaviour

1. Loads the target manifest (and all its transitive imports) via the standard `Loader`.
2. Runs `StaticAnalyzer.analyze()` on the loaded manifests.
3. Filters for error-severity diagnostics.
4. If `expect.errors` is empty, asserts that zero errors were produced.
5. If `expect.errors` has entries, matches each against the diagnostics by `code` (exact) and `message` (substring). Unmatched expectations fail the test.

## Test file conventions

Place fixture manifests in a `__fixtures__/` subdirectory next to the test file. The test runner excludes `__fixtures__/` from automatic test discovery.

```
modules/my-module/
  tests/
    my-test.yaml              ← test file (auto-discovered)
    __fixtures__/
      bad-manifest.yaml        ← fixture (not auto-discovered)
```
