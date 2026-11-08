# `TextDiff.ApplyPatch`

> Examples assume this module is imported under the alias `TextDiff`.

A function kind: an instance holds the size limit, and calling it with a text and a patch returns the patched text, or the reason the patch was refused. The module exports one ready-made instance, `applyPatch`.

```yaml
!cel "TextDiff.applyPatch(steps.file.result.content, steps.edit.result.patch)"
```

## Configuration

| Field           | Type        | Default  | Purpose                                                                                  |
| --------------- | ----------- | -------- | ---------------------------------------------------------------------------------------- |
| `maxInputBytes` | integer ≥ 0 | `262144` | The most UTF-8 bytes the text and the patch each may hold before the patch is refused. |

The exported `applyPatch` declares no configuration, so it uses the default of 256 KiB per input. Declare your own instance for another limit:

```yaml
kind: TextDiff.ApplyPatch
metadata: { name: smallPatch }
maxInputBytes: 65536
```

## Call

`(text, patch)` — both strings. An empty text is a text of no lines. An empty patch is malformed.

## Patch format

A patch is one or more sections, each following the one before directly:

```
<<<<<<< SEARCH
the lines to find
=======
the lines to put in their place
>>>>>>> REPLACE
```

- The three marker lines are matched exactly, with a line feed and no carriage return.
- Between the markers, each line is one line of the text, its newline included. The SEARCH is those lines, each followed by a newline; so a SEARCH of whole lines matches whole lines.
- A REPLACE with no lines deletes the match, newline and all.
- A SEARCH must have at least one line. An empty line is a line: a SEARCH holding one empty line matches a newline.
- Nothing else may stand in the patch: no text before the first marker, between sections, or after the last marker, other than the line feed that ends the patch.

A SEARCH matches byte for byte, anywhere in the text, including the middle of a line. To match a whole line, write the whole line.

## Applying

Sections apply in order. Each SEARCH must occur **exactly once** in the text as the sections before it left it; overlapping occurrences count. A section that matches nowhere, or more than once, stops the application.

Line endings are bytes. CRLF text matches only a SEARCH whose lines end in a carriage return before their newline, which a patch written with line feeds states by carrying the `\r` in the line's content. A plain LF search finds nothing in CRLF text.

A non-empty text whose final line has no newline is matched as if it had one: the sections apply to the text with a line feed appended, and that one appended line feed is then removed from the result if the result still ends with it. So a SEARCH of the last line matches it, and the file keeps its no-final-newline style:

- `a` LF `b` (no final newline), SEARCH `b`, REPLACE `c` gives `a` LF `c`.
- The same text, SEARCH `b`, REPLACE empty, gives `a`, not `a` LF: deleting the last line leaves the previous line without its newline.
- A REPLACE of `c` LF `d` LF gives `a` LF `c` LF `d`.

A text ending in a line feed, and an empty text, are matched exactly as written. Ambiguous matches report the same lines, since the appended line feed starts no line of its own.

## Result

| Field     | Type            | Meaning                                                                                  |
| --------- | --------------- | ---------------------------------------------------------------------------------------- |
| `applied` | boolean         | True when every section applied.                                                         |
| `text`    | string \| null  | The patched text. Null when `applied` is false.                                          |
| `code`    | string \| null  | Why the patch was refused. Null when `applied` is true.                                  |
| `section` | integer \| null | 1-based number of the refused section.                                                   |
| `lines`   | array \| null   | The 1-based line of every match of an ambiguous section, in the text the earlier sections left. |

Every field is always present. When `applied` is true, `code`, `section` and `lines` are null; when it is false, `text` is null.

### Refusals

| `code`                    | When                                                                                                    | `section`                        | `lines`      |
| ------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------ |
| `EDIT_BLOCK_MALFORMED`    | A marker is out of order or missing, a SEARCH is empty, a line stands outside every section, or an input is over the limit. | The section the fault belongs to; null for text outside every section and for an over-limit input. | null |
| `EDIT_SECTION_ABSENT`     | A SEARCH occurs nowhere in the text as the earlier sections left it.                                    | The section.                     | null         |
| `EDIT_SECTION_AMBIGUOUS`  | A SEARCH occurs more than once.                                                                         | The section.                     | Every match. |

A refusal never throws, and never returns a partial text. The patch is parsed in full before any section applies, so a malformed patch changes nothing and names no section that was applied.

The caller decides what a refusal means: the function reports it, and does not retry, reformat or guess a match.

## Bounds

- **Size.** A text or a patch over `maxInputBytes` is refused as `EDIT_BLOCK_MALFORMED` with `section: null`, before anything is parsed.
- **Growth.** The result is at most the text plus the patch in size, since a REPLACE is part of the patch. It is bounded by the limit twice over.
- **Work.** Each section searches the text once. A patch of many sections against a large text costs about that many searches of the text.
