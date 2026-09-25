# Telo validating formats

One JSON file per format, read as one lexically ordered set. A **Telo format**
is a JSON Schema `format:` value whose grammar Telo checks — at `telo check` and
at resource creation alike — rather than one of the formats JSON Schema itself
defines (`email`, `uri`, `date-time`, …). A slot declares one in the ordinary
spelling, `type: string, format: css-selector`; nothing else marks it.

A format is not a value type (`x-telo-type`): the value stays a plain string in
CEL and on the wire, and only the text it may hold is narrowed.

The files live **here**, beside the language halves rather than inside either,
for the reason `analyzer/migrations/` does: every runtime that validates a
manifest must accept exactly the same strings, and a vocabulary written as one
language's code would be a second vocabulary, drifting silently. JSON because it
is the only format all three runtimes embed with no generation step.

`scripts/copy-format-entries.mjs` (the root `prepare`) copies them into
`analyzer/nodejs/src/formats/entries/` and emits the barrel from the same
directory listing, so a file that exists always loads.

## An entry

| key           | meaning |
| ------------- | ------- |
| `name`        | The `format:` value a schema writes. Lower-case, dash-separated. |
| `grammar`     | The normative reference for the grammar, as a URL. |
| `standIn`     | A conforming value. Statically, a CEL expression at a slot of this format is validated as this value, since what it yields is known only once it is evaluated. |
| `description` | What the format accepts, including where it narrows the referenced grammar. |
| `conformance` | `{ valid: [...], invalid: [...] }` — strings every runtime's checker must accept and refuse. |

An entry carries **no code**. Each runtime maps the name to its own checker
(`analyzer/nodejs/src/telo-format.ts` for Node); a name with no checker is a hard
startup error, never a skipped check — a format nothing checks would silently
accept every string at every slot declaring it. The vocabulary is closed: a
`format:` value that is neither a Telo format nor a JSON Schema one is ignored by
the validators, as JSON Schema specifies.

A checker reports WHY a value failed (the position and what was expected there),
and that reason is what both `telo check` and the kernel's refusal print.

## Formats

- **`css-selector`** — a Selectors Level 4 `<complex-selector-list>` in the
  snapshot profile: no pseudo-elements, no namespace prefixes, no leading
  combinator, and `:scope` for the element the selector is matched from (so a
  nested selector relative to it is written `:scope > a`). A relative selector
  (one starting with a combinator) is valid only inside `:has()`, which does not
  nest; `:nth-child(An+B of S)` takes a selector list. State and user-action
  pseudo-classes (`:hover`) are valid syntax — what they match is the consuming
  kind's to say.
