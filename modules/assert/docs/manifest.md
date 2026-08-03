---
description: "Assert.Manifest: runs static analyzer on YAML and asserts on diagnostic codes/messages for negative testing"
sidebar_label: Assert.Manifest
---

# Assert.Manifest

> Examples below assume this module is imported with an `imports:` entry under alias `Assert`. Kind references (`Assert.Manifest`) follow that alias — if you import the module under a different name, substitute your alias accordingly.

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

1. Asks the host for a throwaway kernel (`ctx.createKernel()`) and calls `analyze()` on it. The target manifest and all its transitive imports resolve through the same manifest sources a real run would use; nothing is registered on the host kernel.
2. Collects every diagnostic the analysis produced — including version-reconciliation diagnostics (`MODULE_VERSION_CONFLICT`, `MODULE_VERSION_HOISTED`) — and splits them by severity. A file that fails to parse short-circuits: only the `MANIFEST_PARSE_FAILED` diagnostics are reported, because analyzing a mangled parse tree buries the real error under spurious secondaries.
3. If `expect.errors` is empty, asserts that zero errors were produced.
4. If `expect.errors` has entries, matches each against the diagnostics by `code` (exact) and `message` (substring). Unmatched expectations fail the test.
5. A manifest graph that cannot be loaded at all (unreadable entry, unresolvable import) is a load error, matched against `expect.loadError` rather than `expect.errors`.

## Test file conventions

Place fixture manifests in a `__fixtures__/` subdirectory next to the test file. The test runner excludes `__fixtures__/` from automatic test discovery.

```
modules/my-module/
  tests/
    my-test.yaml              ← test file (auto-discovered)
    __fixtures__/
      bad-manifest.yaml        ← fixture (not auto-discovered)
```
