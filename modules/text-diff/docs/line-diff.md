# `TextDiff.LineDiff`

> Examples assume this module is imported under the alias `TextDiff`.

A function kind: an instance holds how a comparison is made, and calling it with two texts returns their line diff. The module exports one ready-made instance, `lineDiff`.

```yaml
!cel "TextDiff.lineDiff(steps.before.result.content, steps.after.result.content)"
```

## Configuration

| Field           | Type        | Default  | Purpose                                                                    |
| --------------- | ----------- | -------- | -------------------------------------------------------------------------- |
| `contextLines`  | integer ≥ 0 | `3`      | Unchanged lines kept on each side of a change.                             |
| `maxInputBytes` | integer ≥ 0 | `262144` | The most UTF-8 bytes either text may hold before it is refused comparison. |

The exported `lineDiff` declares neither, so it uses the defaults: three context lines and 262144 bytes (256 KiB) per side. Declare your own instance for other values and call it by its name:

```yaml
kind: TextDiff.LineDiff
metadata: { name: compactDiff }
contextLines: 1
maxInputBytes: 65536
---
# … !cel "Self.compactDiff(inputs.before, inputs.after)"
```

## Call

`(before, after)` — both strings. An empty string is a text of no lines.

## Result

| Field        | Type            | Meaning                                                          |
| ------------ | --------------- | ---------------------------------------------------------------- |
| `comparable` | boolean         | False when either text is over `maxInputBytes`.                  |
| `added`      | integer \| null | Lines in `after` that are not in `before`.                       |
| `removed`    | integer \| null | Lines in `before` that are not in `after`.                       |
| `hunks`      | array \| null   | The changes, in order. Empty when the texts are equal.           |

When `comparable` is false, `added`, `removed` and `hunks` are `null` — the texts were not compared, which is different from having no differences. Guard a read accordingly: `d.comparable ? size(d.hunks) : 0`.

### A hunk

`{ oldStart, oldLines, newStart, newLines, lines }` — one run of changes with up to `contextLines` unchanged lines either side. Two changes close enough for their context to meet share a hunk.

- `oldStart` / `newStart` are **1-based** line numbers of the hunk's first line in `before` / `after`; `newStart` is where an editor would jump to see the change.
- `oldLines` / `newLines` count the lines of each text the hunk spans: its context lines plus its removed, or added, lines.
- A side with no line in the hunk — possible only for an empty text or with `contextLines: 0` — starts at the line the hunk *follows*, `0` at the very start. This is the unified diff convention.

### A line

`{ op, text, noNewline? }`:

- `op` is `context` (in both texts), `removed` (only in `before`) or `added` (only in `after`). Within a change, removed lines come before added ones.
- `text` is the line without its newline. A carriage return before the newline is part of the text, so a file whose line endings changed differs on every line.
- `noNewline: true` marks a text's **final line when no newline ends it**. Gaining or losing that newline is a change: `"a\nb\n"` against `"a\nb"` is one line removed (`b`) and one added (`b`, `noNewline: true`).

## Bounds

A call runs to completion inside the expression that makes it, so its work is bounded twice:

- **Size.** A text over `maxInputBytes` is not compared at all; the result is `comparable: false`.
- **Effort.** Finding the *smallest* diff gets expensive as the number of changes grows. Past an internal bound on that work the search stops, and everything between the texts' common beginning and common end is reported as removed and then added. The result is still a correct diff — applying it to `before` yields `after` — only not the shortest one.

## Text only

The comparison is of strings. To diff files, read them as text first and compare what you read; bytes that are not valid UTF-8 do not survive that read, so decide whether a file is text before diffing it — for instance by checking that the digest of the decoded text matches the file's own.
