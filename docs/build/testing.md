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

A test is a `Telo.Application` that imports the stdlib modules it needs, then defines the resource named in `targets:`. Pin each import to an exact registry version (`@<version>`):

```yaml
kind: Telo.Application
metadata:
  name: AddTwoNumbers
  version: 1.0.0
imports:
  Run: std/run@<version>
  JavaScript: std/javascript@<version>
  Assert: std/assert@<version>
targets:
  - TestAdd
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
      code: |
        function main({ a, b }) {
          return { sum: a + b }
        }
  - name: VerifySum
    inputs:
      sum: !cel "steps.AddNumbers.result.sum"
    invoke:
      kind: Assert.Schema
      schema:
        type: object
        properties:
          sum:
            type: number
            const: 8
```

## Running a whole suite

`Test.Suite` (from `std/test`) discovers test manifests by glob, runs each in its own isolated kernel, and reports pass/fail. Write a suite application once and point `telo` at it:

```yaml
kind: Telo.Application
metadata:
  name: TestSuite
  version: 1.0.0
imports:
  Test: std/test@<version>
targets:
  - RunAll
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

See the [`Test.Suite` reference](/reference/std/test/docs/suite) for the full field and CLI-flag list.

## Step shapes

Every step has a `name`. Beyond that, a step is one of several shapes — an invoke, or a control-flow block (conditional, loop, switch, try, throw). The `when:` guard composes with any of them.

### Invoke

`{ name, inputs?, invoke }`. `inputs` is a CEL-templatable map; `invoke` declares the resource to call. The result is available to later steps as `!cel "steps.<name>.result.<field>"`.

### Conditional — `if/then/else`

```yaml
- name: BranchOnValue
  if: !cel "steps.Setup.result.value == 42"
  then:
    - name: Matched
      inputs: { value: !cel "steps.Setup.result.value" }
      invoke:
        kind: Assert.Schema
        schema:
          type: object
          properties:
            value: { const: 42 }
  else:
    - name: NotMatched
      ...
```

### Loop — `while/do`

A do-while pattern emerges naturally from sharing a step name between a pre-loop initializer and the loop body:

```yaml
- name: Counter
  inputs: { n: 0 }
  invoke:
    kind: JavaScript.Script
    code: |
      function main({ n }) { return { n } }

- name: Increment
  while: !cel "steps.Counter.result.n < 3"
  do:
    - name: Counter            # shared name overwrites prior result each iteration
      inputs: { n: !cel "steps.Counter.result.n" }
      invoke:
        kind: JavaScript.Script
        code: |
          function main({ n }) { return { n: n + 1 } }
```

### Switch — `switch/cases/default`

```yaml
- name: RouteByRole
  switch: !cel "steps.ComputeRole.result.role"
  cases:
    admin:
      - name: AdminAction
        ...
    viewer:
      - name: ViewerAction
        ...
  default:
    - name: Fallback
      ...
```

### Try/catch/finally

`error` is bound inside `catch:` with `code`, `message`, `step`, and `data`.

```yaml
- name: Outer
  try:
    - name: Boom
      invoke:
        kind: JavaScript.Script
        code: |
          function main() { throw new Error("caught me") }
  catch:
    - name: Inspect
      inputs:
        msg: !cel "error.message"
        step: !cel "error.step"
      invoke:
        kind: Assert.Schema
        schema:
          type: object
          properties:
            msg: { type: string }
            step: { type: string }
  finally:
    - name: Cleanup
      ...
```

### Throw

`throw:` raises a structured `InvokeError` that the nearest enclosing `catch:` binds as `error`:

```yaml
- name: Boom
  throw:
    code: "UNAUTHORIZED"
    message: "bad token"
    data: { reason: "expired" }
```

### Guard — `when`

`when:` skips a step if the expression is false. Works on plain steps, `if:`, `try:`, `switch:`, and `while:` blocks alike.

```yaml
- name: ShouldSkip
  when: !cel "false"
  inputs: { x: 999 }
  invoke:
    kind: Assert.Schema
    schema:
      type: object
      properties:
        x: { const: 0 }
```

## Assertion kinds

All exported by the `assert` stdlib (`Assert: std/assert@<version>`):

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

- [`Test.Suite` reference](/reference/std/test/docs/suite) — discovery, isolation, and CLI flags.
- [`Run.Sequence` reference](/reference/std/run) — the full step grammar.
- [Installation & CLI](/learn/installation-and-cli) — running and watching manifests with `telo`.
