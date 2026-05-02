---
description: "How to write Telo YAML manifest tests using Run.Sequence and the Assert.* kinds"
---

# Testing

Telo tests are themselves Telo manifests: a `Run.Sequence` (or top-level `Assert.Events` / `Assert.Manifest`) drives the test, and the `Telo.Application`'s `targets:` list invokes it. The repo-wide `test-suite.yaml` orchestrates discovery via `Test.Suite`, globbing `**/tests/*.yaml` and excluding `**/__fixtures__/**`.

## Where tests live

- **Cross-cutting kernel/analyzer tests** — `tests/`. Exercise the module system (`include`, `Telo.Import`), `Telo.Definition` semantics (`extends`, `capability`), and topology rules.
- **Module-specific tests** — `modules/<name>/tests/`. Per `CLAUDE.md`, every test should live next to the module it exercises.
- **Fixtures** — any `__fixtures__/` subdirectory. Excluded from discovery; reference them from a test via `source: ./__fixtures__/foo.yaml` or `include: [./__fixtures__/foo.yaml]`.

## Running tests

```bash
pnpm run test                      # run everything
pnpm run test if                   # filter by substring (matches "run-sequence-if.yaml")
pnpm run test --filter=if          # same, explicit
pnpm run telo ./modules/run/tests/run-sequence-if.yaml   # run one manifest directly
```

## Anatomy of a test manifest

Every test starts with a `Telo.Application`, declares `Telo.Import` aliases for each stdlib it uses, and defines the resource named in `targets:`:

```yaml
kind: Telo.Application
metadata:
  name: AddTwoNumbers
  version: 1.0.0
targets:
  - TestAdd
---
kind: Telo.Import
metadata: { name: Run }
source: ../../run
---
kind: Telo.Import
metadata: { name: JavaScript }
source: ../../javascript
---
kind: Telo.Import
metadata: { name: Assert }
source: ../../assert
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
      sum: "${{ steps.AddNumbers.result.sum }}"
    invoke:
      kind: Assert.Schema
      schema:
        type: object
        properties:
          sum:
            type: number
            const: 8
```

Adjust the `source:` paths to the relative location of each module from your test file. From `modules/<name>/tests/` use `../../<other-module>`; from the root `tests/` use `../modules/<other-module>`.

## Step shapes

Every step has a `name`. Beyond that, a step is one of several shapes — an invoke, or a control-flow block (conditional, loop, switch, try, throw). The `when:` guard composes with any of them.

### Invoke

`{ name, inputs?, invoke }`. `inputs` is a CEL-templatable map; `invoke` declares the resource to call. The result is available to later steps as `${{ steps.<name>.result.<field> }}`.

### Conditional — `if/then/else`

```yaml
- name: BranchOnValue
  if: "${{ steps.Setup.result.value == 42 }}"
  then:
    - name: Matched
      inputs: { value: "${{ steps.Setup.result.value }}" }
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
  while: "${{ steps.Counter.result.n < 3 }}"
  do:
    - name: Counter            # shared name overwrites prior result each iteration
      inputs: { n: "${{ steps.Counter.result.n }}" }
      invoke:
        kind: JavaScript.Script
        code: |
          function main({ n }) { return { n: n + 1 } }
```

### Switch — `switch/cases/default`

```yaml
- name: RouteByRole
  switch: "${{ steps.ComputeRole.result.role }}"
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
        msg: "${{ error.message }}"
        step: "${{ error.step }}"
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
  when: "${{ false }}"
  inputs: { x: 999 }
  invoke:
    kind: Assert.Schema
    schema:
      type: object
      properties:
        x: { const: 0 }
```

## Assertion kinds

All exported by the `assert` stdlib (`Telo.Import name: Assert`, `source: ../../assert` from a module test, `../modules/assert` from the root `tests/`).

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
2. **Runtime errors** — wrap the failing step in `try/catch` and assert against `${{ error.code }}`, `${{ error.message }}`, `${{ error.step }}`, `${{ error.data.* }}`. See `modules/run/tests/invoke-error.yaml` for the canonical example.

## See also

- [`../test-suite.yaml`](../test-suite.yaml) — discovery entry point.
- [`../modules/test/docs/suite.md`](../modules/test/docs/suite.md) — `Test.Suite` reference and CLI flags.
