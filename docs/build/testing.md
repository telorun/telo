---
sidebar_label: Testing your manifests
slug: /build/testing
description: Test Telo manifests with Telo manifests — Run.Sequence drives the test, Assert.* checks the result, and the telo CLI runs it.
---

# Testing your manifests

Telo tests are themselves Telo manifests: a `Run.Sequence` (or a top-level `Assert.Events` / `Assert.Manifest`) drives the test, and the `Telo.Application`'s `targets:` list invokes it. Because a test runs on the same kernel you deploy, the behaviour you assert in development is the behaviour you get in production.

Run a single test manifest with the [`telo` CLI](/learn/installation-and-cli):

```bash
telo ./tests/add-two-numbers.yaml
```

## Where to put tests

Keep tests next to the manifest they exercise — a `tests/` directory beside your application or library is the convention. Shared inputs (sample manifests a test loads via `source:` or `include:`) go in a `__fixtures__/` subdirectory so a suite can skip them during discovery.

## Anatomy of a test manifest

A test is a `Telo.Application` that imports the stdlib modules it needs, then defines the resource named in `targets:`. Pin each import to an exact published version (`@<version>`):

```yaml
kind: Telo.Application
metadata:
  name: AddTwoNumbers
  version: 1.0.0
imports:
  Run: oci://ghcr.io/telorun/run@<version>
  JavaScript: oci://ghcr.io/telorun/javascript@<version>
  Assert: oci://ghcr.io/telorun/assert@<version>
targets:
  - !ref TestAdd
---
kind: Run.Sequence
metadata:
  name: TestAdd
steps:
  - name: AddNumbers
    inputs:
      a: 5
      b: 3
    invoke:
      kind: JavaScript.Script
      outputType:
        kind: Telo.JsonSchema
        schema:
          type: object
          properties:
            sum: { type: integer }
          required: [sum]
      code: |
        function main({ a, b }) {
          return { sum: a + b }
        }
  - name: VerifySum
    inputs:
      actual: !cel "steps.AddNumbers.result.sum"
      expected: 8
    invoke:
      kind: Assert.Equals
```

Prefer `Assert.Equals` over `Assert.Schema` for checking an output: it reads as
a plain expected value and compares the whole result at once. Declaring
`outputType` on the script is what makes `steps.AddNumbers.result.sum`
type-check rather than fall back to a permissive shape.

## Running a whole suite

`Test.Suite` (from the `test` module) discovers test manifests by glob, runs each in its own isolated kernel, and reports pass/fail. Write a suite application once and point `telo` at it:

```yaml
kind: Telo.Application
metadata:
  name: TestSuite
  version: 1.0.0
imports:
  Test: oci://ghcr.io/telorun/test@<version>
targets:
  - !ref RunAll
---
kind: Test.Suite
metadata:
  name: RunAll
include:
  - "**/tests/*.yaml"
exclude:
  - "**/__fixtures__/**"
```

```bash
telo ./test-suite.yaml                 # run everything
telo ./test-suite.yaml add             # filter by substring (matches "add-two-numbers.yaml")
telo ./test-suite.yaml --filter=add    # same, explicit
```

See the [`Test.Suite` reference on the hub](https://hub.telo.run/?q=Test.Suite) for the full field and CLI-flag list.

## Step shapes

A test drives its assertions with the ordinary `Run.Sequence` grammar — invoke,
`if`/`then`/`else`, `while`/`do`, `switch`/`cases`, `try`/`catch`/`finally`,
`throw`, and the `when:` guard. All of it is documented once, in
[Composing behaviour](/learn/composing-behaviour); none of it is test-specific.

Two shapes come up constantly in tests:

```yaml
# Assert on an earlier step's result — actual/expected are call inputs
- name: VerifySum
  inputs:
    actual: !cel "steps.AddNumbers.result.sum"
    expected: 8
  invoke:
    kind: Assert.Equals

# Assert that something fails, and how
- name: Attempt
  try:
    - name: Boom
      throw:
        code: UNAUTHORIZED
        message: "bad token"
  catch:
    - name: Inspect
      inputs:
        actual: !cel "error.code"
        expected: UNAUTHORIZED
      invoke:
        kind: Assert.Equals
```

`error.step` inside a `catch:` names the **enclosing** step that failed
(`Attempt` above), not the inner one.

## Assertion kinds

All exported by the `assert` stdlib (`Assert: oci://ghcr.io/telorun/assert@<version>`):

| Kind | Use for | Where it goes |
|---|---|---|
| `Assert.Schema` | JSON Schema validation on `inputs` | Step (`invoke.kind`) |
| `Assert.Equals` | Deep equality | Step |
| `Assert.Matches` | Regex match on a string | Step |
| `Assert.Contains` | Substring / element / property containment | Step |
| `Assert.Events` | Asserts an ordered subsequence of kernel events | Top-level resource |
| `Assert.Manifest` | Asserts the analyzer emits specific diagnostic codes for a fixture | Top-level resource |

### `Assert.Events`

Watches the kernel event stream and asserts an ordered subsequence:

```yaml
kind: Assert.Events
metadata: { name: ExpectEvents }
filter:
  - type: "*"
expect:
  - event: JavaScript.Script.*.Invoked
    payload:
      outputs: { sum: 8 }
  - event: Assert.Schema.*.Invoked
    payload:
      outputs: true
```

### `Assert.Manifest`

Asserts the analyzer's diagnostics on a fixture without running it:

```yaml
kind: Assert.Manifest
metadata: { name: TestExtendsMalformed }
source: ./__fixtures__/extends-malformed.yaml
expect:
  errors:
    - code: EXTENDS_MALFORMED
```

## Negative-path patterns

Two shapes:

1. **Static-analysis errors** — use `Assert.Manifest` with a fixture under `__fixtures__/` and an expected `errors[].code`.
2. **Runtime errors** — wrap the failing step in `try/catch` and assert against `!cel "error.code"`, `!cel "error.message"`, `!cel "error.step"`, `!cel "error.data.*"`.

## See also

- [`Test.Suite` reference on the hub](https://hub.telo.run/?q=Test.Suite) — discovery, isolation, and CLI flags.
- [`Run.Sequence` reference on the hub](https://hub.telo.run/?q=Run.Sequence) — the full step grammar.
- [Installation & CLI](/learn/installation-and-cli) — running and watching manifests with `telo`.
