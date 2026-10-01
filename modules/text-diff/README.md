# Text Diff

Compare two texts line by line and get the result as data: how many lines were added and removed, and the changes grouped into hunks with their surrounding context — what a unified diff shows, without parsing a patch. `TextDiff.LineDiff` is a CEL function kind, so a diff is one expression wherever an expression is allowed.

## Why use this

- **Callable from any CEL expression** — a step's `value:`, an `outputs:` map, a route's response — as `TextDiff.lineDiff(before, after)`, with a typed result `telo check` understands.
- **Structured, not text** — each hunk carries its line ranges on both sides and its lines tagged `context` / `added` / `removed`, ready for a UI to render or a summary to count.
- **Bounded** — a text over the instance's byte limit is reported as not comparable instead of being diffed, and a comparison with very many changes stops searching for the smallest diff rather than running long.
- **Deterministic** — the same two texts always give the same diff, so a call is allowed wherever a deterministic function is required.

## Kinds and instances

| Name | What it is |
| --- | --- |
| `TextDiff.LineDiff` | A function kind: configure `contextLines` and `maxInputBytes`, call with `before` and `after`. |
| `TextDiff.lineDiff` | A ready-made instance: three lines of context, texts of up to 256 KiB each. |

## Example

Report what an edit changed:

```yaml
kind: Telo.Application
metadata: { name: Notes, version: 1.0.0 }
imports:
  TextDiff: oci://ghcr.io/telorun/text-diff@<version>
  Run: oci://ghcr.io/telorun/run@<version>
targets:
  - !ref describeEdit
---
kind: Run.Sequence
metadata: { name: describeEdit }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [before, after]
    properties:
      before: { type: string }
      after: { type: string }
steps:
  - name: diff
    value: !cel "TextDiff.lineDiff(inputs.before, inputs.after)"
outputs:
  added: !cel "steps.diff.result.added"
  removed: !cel "steps.diff.result.removed"
  hunks: !cel "steps.diff.result.hunks"
```

Replacing the fifth of ten lines gives:

```yaml
comparable: true
added: 1
removed: 1
hunks:
  - oldStart: 2
    oldLines: 7
    newStart: 2
    newLines: 7
    lines:
      - { op: context, text: two }
      - { op: context, text: three }
      - { op: context, text: four }
      - { op: removed, text: five }
      - { op: added, text: FIVE }
      - { op: context, text: six }
      - { op: context, text: seven }
      - { op: context, text: eight }
```

## Reference

- [`TextDiff.LineDiff`](docs/line-diff.md) — configuration, the result shape, line and newline rules, and the bounds.
