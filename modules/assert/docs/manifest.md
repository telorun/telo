---
description: "Assert.Manifest: runs static analyzer on YAML and asserts on diagnostic codes/messages for negative testing, and optionally that the manifest also fails to run"
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
| `expect.errors[].fix` | string | no | Substring to match in the diagnostic's suggested replacement. Matching it also asserts that a repair was offered at all — a diagnostic with no fix never matches. |
| `expect.warnings` | array | no | Expected analysis warnings, matched the same way. Checked only when declared; extra warnings are not failures. |
| `expect.loadError` | string | no | Substring to match in a manifest load error. Asserts that loading fails. |
| `expect.runFails` | string | no | Runs the manifest as well, and asserts it exits non-zero with this substring on stderr. |

## Behaviour

1. Loads the target manifest (and all its transitive imports) via the standard `Loader`.
2. Runs `StaticAnalyzer.analyze()` on the loaded manifests.
3. Filters for error-severity diagnostics.
4. If `expect.errors` is empty, asserts that zero errors were produced.
5. If `expect.errors` has entries, matches each against the diagnostics by `code` (exact), `message` (substring) and `fix` (substring against the suggested replacement). Every declared matcher must hold. Unmatched expectations fail the test.

## Asserting a suggested fix

Some diagnostics carry a mechanically applicable repair — the whole corrected value, not a fragment — which editors offer as a quick fix and agents apply directly. `fix:` asserts it:

```yaml
expect:
  errors:
    - code: CEL_WRONG_CALL_FORM
      fix: "key.startsWith('uploads/')"
```

Assert the repair rather than only the message when the repair is the point: a message can read correctly while the replacement is missing, stale, or anchored to the wrong span, and only `fix:` catches that. A diagnostic that deliberately offers no repair (an ambiguous correction, where applying a guess would be worse than none) never matches a `fix:` expectation.

## Asserting that the kernel refuses it too

`runFails:` runs the manifest and asserts it exits non-zero with the given
substring on stderr. It exists to pin a **static verdict to the runtime one** in
one test: a manifest `telo check` refuses is a manifest the kernel refuses.

That agreement is not automatic. A rule enforced only in a controller passes
`telo check` and fails at boot — which is how a template dispatching to a
nonexistent entry, a `base:` that was never evaluated, and a client whose
credential could not be resolved all shipped as clean checks. Each of those had
an excellent runtime message and no static half, and nothing anywhere asserted
the two agree.

Point `source:` at a CONSUMER of the library carrying the defect. Analysis is
entry-scoped, so the consumer's own `telo check` is silent about a dependency's
internals by design — which makes the kernel's guard the only thing left, and
therefore the thing worth asserting:

```yaml
# The library's own check reports it…
kind: Assert.Manifest
metadata:
  name: baseWithBody
source: ./__fixtures__/base-with-body/lib/telo.yaml
expect:
  errors:
    - code: BASE_WITH_TEMPLATE_BODY
---
# …and a consumer, whose check is clean, still cannot run it.
kind: Assert.Manifest
metadata:
  name: baseWithBodyAtRuntime
source: ./__fixtures__/base-with-body/telo.yaml
expect:
  runFails: "may not also declare 'resources:'"
```

Assert the repaired twin too, or a suite passes by refusing everything — and use
`runs: true` for it, not `expect: {}`:

```yaml
kind: Assert.Manifest
metadata:
  name: baseWithBodyRepaired
source: ./__fixtures__/base-with-body-repaired/telo.yaml
expect:
  runs: true
```

`expect: {}` asserts a clean check and **nothing about running**, so on its own it
cannot tell a working fixture from one the kernel would refuse. `runs: true` runs
the manifest and requires exit 0; `runFails` is its negative counterpart. Both are
bounded — a fixture still going after 30s is cancelled and reported as a failure,
so a regression into "runs forever" is a failing test rather than a hung suite.

## Test file conventions

Place fixture manifests in a `__fixtures__/` subdirectory next to the test file. The test runner excludes `__fixtures__/` from automatic test discovery.

```
modules/my-module/
  tests/
    my-test.yaml              ← test file (auto-discovered)
    __fixtures__/
      bad-manifest.yaml        ← fixture (not auto-discovered)
```
