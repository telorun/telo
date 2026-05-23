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

## Example

```yaml
kind: Telo.Import
metadata: { name: Assert }
source: std/assert@latest
---
kind: Assert.Equals
metadata: { name: CheckTotal }
expected: 42
actual: !cel "resources.AddNumbers.result"
```

## Reference

- [`Assert.Manifest`](docs/manifest.md)
