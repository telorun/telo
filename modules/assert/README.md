# Assert

Inline assertions for Telo manifests — pluggable matchers that compare actual values against expected values inside `Test.Suite` cases or any sequence step.

## Why use this

- **Manifest-native** — assertions are resources, not host-language code, so they compose with the same scoping and dependency rules as the rest of your manifest.
- **Drop-in matchers** — `Equals`, `Matches`, `Contains` cover the common comparisons without writing a controller.
- **Schema-aware checks** — `Schema` validates a value against a JSON Schema; `Manifest` walks structured manifest data and asserts on it.
- **Observability hooks** — `Events` asserts on emitted kernel events for behaviour-level testing.

## Kinds

| Kind | Purpose |
| --- | --- |
| `Assert.Equals` | Assert two values are deep-equal. |
| `Assert.Matches` | Assert a string matches a regex / pattern. |
| `Assert.Contains` | Assert a collection or string contains a value. |
| `Assert.Schema` | Validate a value against a JSON Schema. |
| `Assert.Manifest` | Walk structured manifest data and assert on it. |
| `Assert.Events` | Assert on emitted kernel events. |
| `Assert.ModuleContext` | Capture the module-level context for assertions. |

## Exported instances

`Equals`, `Matches`, and `Contains` are config-free — the comparison args arrive at invoke time — so the library ships them as ready-made singletons via `exports.resources`. Reference them with `!ref Assert.<name>` (including inside a `Run.Sequence` step) instead of declaring an instance:

| Export | Kind |
| --- | --- |
| `Assert.equals` | `Assert.Equals` |
| `Assert.matches` | `Assert.Matches` |
| `Assert.contains` | `Assert.Contains` |

```yaml
kind: Run.Sequence
metadata: { name: Check }
steps:
  - name: Total
    invoke: !ref Assert.equals
    inputs:
      actual: !cel "steps.Add.result.total"
      expected: 42
```

The config-bearing kinds (`Schema`, `Manifest`, `Events`, `ModuleContext`) carry per-instance state, so they stay instance-per-use and are not exported as singletons.

## Example

```yaml
kind: Telo.Application
metadata: { name: assert-app, version: 1.0.0 }
imports:
  Assert: oci://ghcr.io/telorun/assert@0.10.5
  Run: oci://ghcr.io/telorun/run@0.13.0
  JS: oci://ghcr.io/telorun/javascript@0.7.0
targets: [ !ref Check ]
---
kind: JS.Script
metadata: { name: AddNumbers }
code: |
  export function main() { return { total: 42 } }
---
# `actual` / `expected` are invoke inputs, not resource fields — the matchers
# themselves are config-free.
kind: Run.Sequence
metadata: { name: Check }
steps:
  - name: Add
    invoke: !ref AddNumbers
  - name: Total
    invoke: !ref Assert.equals
    inputs:
      actual: !cel "steps.Add.result.total"
      expected: 42
```

## How `Assert.Equals` compares

Deep equality over the JSON-shaped values a Telo step passes around: primitives, plain objects, and arrays. A non-plain object (`Date`, `Map`, `Set`, `RegExp`, a class instance) is **not** compared structurally — only identity passes — because two distinct `new Date(...)` instances both have no own keys and would otherwise compare equal. Serialize first (`date.toISOString()`) and compare the strings.

An integer compares by value across its representation. A CEL integer is int64 while an `expected:` literal comes out of YAML as a plain number, and YAML has no way to write the other — so `!cel "size(items)"` equals `3`. The match is exact in both directions: the literal must be integral and round-trip to the same int64, so neither `3.5` nor a magnitude a double cannot represent will match.

`Assert.Events` compares its `payload:` leaves the same way. It is a **subset** match — only the keys the expectation names are compared, recursively — but each leaf it does compare uses the rule above, so an integer-valued expression in an event payload is assertable against a plain YAML number.

## Asserting *that* something happened, and *how many times*

`Assert.Events` entries come in two forms, and they answer different questions.

Without `times:`, an entry asserts the event **occurred**, matched in order against the entries around it. This is a subsequence match: it scans forward and ignores everything else, so extra events never fail it.

```yaml
expect:
  - event: chargeCard.Invoked      # happened, at some point after the previous entry
```

With `times:`, an entry asserts **how many** there were, counted over the whole capture:

```yaml
filter:
  - type: "chargeCard.Invoked"
expect:
  - event: chargeCard.Invoked
    times: 1                       # exactly once — twice fails
```

That is the assertion the ordered form cannot make, and it is worth having because the kernel already records every dispatch: "did this run a second time?" is answerable from the event stream rather than from a counter kept inside the work. A global in a script only proves a function body ran; the event proves the step was **dispatched**, which is the distinction that matters wherever something may return a cached, memoised or replayed result without executing.

Two properties follow from counting over the whole capture rather than from wherever the ordered walk has reached:

- the number does not change when an unrelated expectation moves — a manifest reporting a different count because a neighbouring entry was reordered would be unusable;
- a counted entry **does not consume a position**, so ordered and counted entries mix freely in one list without either changing what the other means.

`times: 0` asserts the event never happened. It falls out of the same rule rather than being a separate feature — and it is the one thing the ordered form structurally cannot express, since absence is its *failure* rather than its success.

Narrow `filter:` alongside a count when the pattern is a wildcard: the filter decides what is captured, and counting what you did not intend to capture is the one way to get a confidently wrong number.

## Reference

- [`Assert.Manifest`](docs/manifest.md)
