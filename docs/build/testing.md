---
sidebar_label: Testing your manifests
slug: /build/testing
description: Test Telo manifests with Telo manifests — Run.Sequence drives the test, Assert.* checks the result, and the telo CLI runs it.
---

# Testing your manifests

Telo tests are themselves Telo manifests: a `Run.Sequence` (or a top-level `Assert.Events` / `Assert.Manifest`) drives the test, and the `Telo.Application`'s `targets:` list invokes it. Because a test runs on the same kernel you deploy, the behaviour you assert in development is the behaviour you get in production.

Run a single test manifest with the [`telo` CLI](/learn/telo-cli):

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
  Assert: oci://ghcr.io/telorun/assert@<version>
targets:
  - !ref testAdd
---
kind: Run.Value
metadata:
  name: add
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      a: { type: integer }
      b: { type: integer }
    required: [a, b]
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      sum: { type: integer }
    required: [sum]
value:
  sum: !cel "inputs.a + inputs.b"
---
kind: Run.Sequence
metadata:
  name: testAdd
steps:
  - name: addNumbers
    invoke: !ref add
    inputs: { a: 5, b: 3 }
  - name: verifySum
    invoke: { kind: Assert.Equals }
    inputs:
      actual: !cel "steps.addNumbers.result.sum"
      expected: 8
```

Prefer `Assert.Equals` over `Assert.Schema` for checking an output: it reads as
a plain expected value and compares the whole result at once. Declaring
`outputType` on `add` is what makes `steps.addNumbers.result.sum` type-check
rather than fall back to a permissive shape.

## Testing an HTTP API

An application that serves requests is tested through its own front door. Declare
it with `App.Instance` in a `Run.Sequence`'s `with:` block, and call it with
`HttpClient.Request`. The child is listening before the first step, so the call
needs no retry, and it is gone after the last step, so the port is free again.
This test runs the finished application from [Your first HTTP API](/learn/first-http-api),
which sits in the directory above `tests/`:

```yaml
kind: Telo.Application
metadata:
  name: GreetingApiTest
  version: 1.0.0
imports:
  Run: oci://ghcr.io/telorun/run@<version>
  App: oci://ghcr.io/telorun/app@<version>
  HttpClient: oci://ghcr.io/telorun/http-client@<version>
  Assert: oci://ghcr.io/telorun/assert@<version>
targets:
  - !ref test
---
kind: Run.Sequence
metadata: { name: test }
with:
  - kind: App.Instance
    metadata: { name: greetingApp }
    source: ../telo.yaml
    ports: { http: 8942 }
    variables: { greeting: Hej }
targets:
  - !ref greetingApp
steps:
  - name: greet
    invoke:
      kind: HttpClient.Request
      method: GET
      url: http://127.0.0.1:8942/v1/greet?name=World
  - name: verify
    invoke: { kind: Assert.Equals }
    inputs:
      actual:
        status: !cel "steps.greet.result.status"
        body: !cel "steps.greet.result.body"
      expected:
        status: 200
        body: { message: "Hej, World!" }
```

- **Inputs are supplied by the name the child declares** — `ports.http` and
  `variables.greeting` here, never `PORT` or `GREETING`. `telo check` follows
  `source` and refuses a name the child does not declare.
- **Give every test a port of its own.** Tests in a suite run side by side, and a
  port two of them bind is a test that fails for no reason in the code.
- **Assert on `steps.<name>.result.status` and `.body`** with `Assert.Equals`,
  as above.

### With a database

A test must not depend on what a previous run left behind. For a SQLite-backed
application, let the file variable also accept `:memory:` and hand the test a
database of its own, discarded with the child. In the notes application from
[Talking to a database](/learn/talking-to-a-database), `dbFile` becomes:

```yaml
variables:
  dbFile:
    env: DB_FILE
    type: string
    anyOf:
      - { const: ":memory:" }
      - { x-telo-type: { name: Telo.HostPath, entry: file } }
    default: ./notes.db
```

and the test's child is started with `variables: { dbFile: ":memory:" }` on another port:

```yaml
kind: Run.Sequence
metadata: { name: test }
with:
  - kind: App.Instance
    metadata: { name: notesApp }
    source: ../telo.yaml
    ports: { http: 8941 }
    variables: { dbFile: ":memory:" }
targets:
  - !ref notesApp
steps:
  - name: create
    invoke:
      kind: HttpClient.Request
      method: POST
      url: http://127.0.0.1:8941/v1/notes
      headers: { content-type: application/json }
      body: { title: first, body: hello }
  - name: list
    invoke:
      kind: HttpClient.Request
      method: GET
      url: http://127.0.0.1:8941/v1/notes
  - name: verify
    invoke: { kind: Assert.Equals }
    inputs:
      actual:
        created: !cel "steps.create.result.body"
        listed: !cel "steps.list.result.body"
      expected:
        created: { created: 1 }
        listed: [{ id: 1, title: first, body: hello }]
```

The first row is always `id: 1`, because the table starts empty on every run.
When a test has to use a database file that outlives it, identify each row it
writes per run (`uuidv4()`) instead of assuming the table is empty.

## Running a whole suite

`Test.Suite` (from the `test` module) discovers test manifests by glob, runs each in its own isolated kernel, and reports pass/fail. Write a suite application once and point `telo` at it:

```yaml
kind: Telo.Application
metadata:
  name: TestSuite
  version: 1.0.0
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
  Test: oci://ghcr.io/telorun/test@<version>
targets:
  - !ref runAll
---
kind: Test.Suite
metadata:
  name: runAll
include: !cel "variables.include"
exclude:
  - "**/__fixtures__/**"
filter: !cel "variables.filter"
```

The suite's command line is whatever the application declares with `arg:` — here a repeatable `--include` and a positional filter:

```bash
telo ./test-suite.yaml                                   # run everything
telo ./test-suite.yaml add                               # filter by substring (matches "add-two-numbers.yaml")
telo ./test-suite.yaml --include tests/add-two-numbers.yaml  # exactly this manifest
telo ./test-suite.yaml --help                            # what the suite accepts
```

See the [`Test.Suite` reference on the hub](https://hub.telo.run/?q=Test.Suite) for the full field list.

## When a test fails

A failed step reports where its input was written, the way `telo check` reports a diagnostic — under `telo` directly and inside a `Test.Suite` run alike:

```
tests/add-two-numbers.yaml:43:17  error  Assert.Equals "SequenceTestAddSteps1VerifySum": expected 9, got 8  ERR_ASSERTION_FAILED
```

The position is the node inside the failing step's `inputs:` the failure is about (for `Assert.Equals`, the first difference in `expected`), in the innermost sequence that ran the step, whether its target is declared inline or by `!ref`. Where the step the runtime ran is not the one written there — a step a template body declares, or one whose list an `!if` or `!for-each` reshaped — the failure names the resource and gives no position rather than a wrong one.

## Step shapes

A test drives its assertions with the ordinary `Run.Sequence` grammar — invoke,
`if`/`then`/`else`, `while`/`do`, `switch`/`cases`, `try`/`catch`/`finally`,
`throw`, and the `when:` guard. All of it is documented once, in
[Composing behaviour](/learn/composing-behaviour); none of it is test-specific.

Two shapes come up constantly in tests:

```yaml
# Assert on an earlier step's result — actual/expected are call inputs
- name: verifySum
  inputs:
    actual: !cel "steps.addNumbers.result.sum"
    expected: 8
  invoke:
    kind: Assert.Equals

# Assert that something fails, and how
- name: attempt
  try:
    - name: boom
      throw:
        code: UNAUTHORIZED
        message: "bad token"
  catch:
    - name: inspect
      inputs:
        actual: !cel "error.code"
        expected: UNAUTHORIZED
      invoke:
        kind: Assert.Equals
```

`error.step` inside a `catch:` names the **enclosing** step that failed
(`attempt` above), not the inner one.

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

Watches the kernel event stream and asserts an ordered subsequence. An event is named after the resource that was dispatched — here the `add` of the anatomy test above; list `expectEvents` in `targets:` beside `testAdd`:

```yaml
kind: Assert.Events
metadata: { name: expectEvents }
filter:
  - type: "*.Invoked"
expect:
  - event: add.Invoked
    payload:
      outputs: { sum: 8 }
```

### `Assert.Manifest`

Asserts the analyzer's diagnostics on a fixture without running it:

```yaml
kind: Assert.Manifest
metadata: { name: testExtendsMalformed }
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
- [Telo CLI](/learn/telo-cli) — running and watching manifests with `telo`.
