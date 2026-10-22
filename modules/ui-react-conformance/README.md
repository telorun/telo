# UI React conformance

Checks a theme or a set of controls for [`ui-react`](../ui-react/README.md)
against the renderer's contract, from the tests of the module that publishes it.
Every screen element the renderer has is drawn in a simulated browser, and the
check answers what is wrong: a part the theme leaves unstyled, a layout property
it must not set, a design token it gives no value or never reads, a stylesheet
that does not parse, a screen that breaks under the theme's controls, a control
that fails one of its behaviour vectors. An empty list means the theme
conforms.

## Why use this

- **No suite to copy.** The vectors, the scenes that draw every part and the
  reserved properties are `ui-react`'s own data, and the design token names
  `ui`'s; a theme module imports this one and asserts `problems: []`.
- **The same oracle as the built-ins.** The renderer's own controls are proven
  on the same vectors and scenes, in the same DOM at the same version.
- **Answers, not failures.** Each problem names its check, what it is about
  and what to do, so a test pins the exact list.

## Kinds

| Kind | Purpose |
| --- | --- |
| [`UiReactConformance.CheckTheme`](docs/checks.md#checktheme) | Check a `UiReact.Theme`: its look over every scene, and each of its control sets. |
| [`UiReactConformance.CheckControls`](docs/checks.md#checkcontrols) | Check one `UiReact.Controls` set against the vectors of every control it implements. |

## Example

```yaml
kind: Telo.Application
metadata: { name: AcmeThemeConformance, version: 1.0.0 }
imports:
  Acme: ../
  Conformance: oci://ghcr.io/telorun/ui-react-conformance
  Run: oci://ghcr.io/telorun/run
  Assert: oci://ghcr.io/telorun/assert
targets:
  - !ref conforms
---
kind: Run.Sequence
metadata: { name: conforms }
steps:
  - name: check
    invoke:
      kind: Conformance.CheckTheme
      theme: !ref Acme.theme
  - name: noProblems
    inputs:
      actual: !cel "steps.check.result.problems"
      expected: []
    invoke:
      kind: Assert.Equals
```

## Docs

- [The checks](docs/checks.md) — what each kind checks, the problem vocabulary,
  and the window the checks run in.
