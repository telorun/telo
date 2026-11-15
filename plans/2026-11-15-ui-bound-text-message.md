---
status: draft
priority: low
depends-on: []
packages: [modules/ui, modules/ui-react, modules/crud-ui, examples/ui-showcase, examples/chat, apps/hub, apps/authoring-agent, docs]
refinement: not-started
---

# A text over data names its message `message`

## Problem

A text over data is `Ui.BoundText` `{ text, values }`: the message and the values that fill its placeholders. Wherever the field holding it is itself named `text` — the `text`, `badge` and `link` nodes — the word is written twice, and with a translation context three times:

```yaml
- type: text
  text:
    text: { text: "{$n} open tasks", context: dashboard }
    values: { n: !cel "data.open" }
```

The inner `text` is the message, a MessageFormat 2 pattern; the outer one is the node's field; the innermost is `Text`'s own object form. Nothing but position tells them apart. The renderer's form of the shape repeats it: a bound text crosses as `{ text: <text record>, values }`.

## Constraints

None.

## Surface

**Added**

- `Ui.BoundText.message` — the message the values fill: a `Text` (a pattern, a plural selection, or `{ text, context }`).
- Wire: a bound text crosses as `{ message, values }`, `message` a text record.

**Changed**

- `Ui.BoundText` — the object form is `{ message, values }`; a plain `Text` is unchanged.
- `x-telo-text-values-for` on `Ui.BoundText.values` — points at `/message`.

**Removed**

- `text` inside a `Ui.BoundText` — `SCHEMA_VIOLATION`; `message` replaces it.
- `text` inside the wire's bound text — `message` replaces it.

## Solution

**`message` is the word for the pattern**, as MessageFormat 2 and FormatJS (`defaultMessage`, `message`) name it. The object form of `Ui.BoundText` becomes `{ message, values }`; every site taking a bound text — a node's `text`, a `badge`, a link's `text`, an `alt`, a value's `text`, a list's `heading`, a column's `header`, an enablement's `disabledText`, a confirmation, a press's `label` — reads the same way:

```yaml
- type: text
  text:
    message: { text: "{$n} open tasks", context: dashboard }
    values: { n: !cel "data.open" }
- type: link
  text: { message: "Open {$title}", values: { title: !cel "row.title" } }
```

A plain `Text` — a pattern with no placeholders, a plural selection over no values, `{ text, context }` — is still written directly, unchanged. The core `Text` fragment keeps its own `{ text, context }` form: it is the built-in vocabulary every module's texts use, and its `text` is the only word at its level.

**Every check is kept**, now pointing at `message`: `MESSAGE_SYNTAX_INVALID`, `MESSAGE_PLACEHOLDER_UNBOUND`, `MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED`, `MESSAGE_PLURAL_CATEGORY_INVALID`, the refusal of a placeholder in a plain text, and each value typed as an accessor — the pairing is `x-telo-text-values-for: /message`. The old key is `SCHEMA_VIOLATION`, refused by `telo check` and again when the resource is created, the schema's message naming `message`.

**The renderer's shape follows.** `ui` hands a bound text over as `{ message, values }` — `message` the text record, `values` the bindings — so the authored and the received shape use one word for one thing. `@telorun/ui`'s text translation walks the spec by its schema, so it follows the rename with no change of its own; `ui-react` reads `message`.

**No migration.** A migration reaches a document by its `kind:` and top-level keys, and a bound text sits at any depth inside node trees of every `Ui` kind, written under whatever alias the consumer chose; telling a bound text's `text` from any other `text` beside a `values` needs the schema the loader does not have yet. In-repo manifests are updated, and the `ui` fragment describes the break and the one-line rewrite.

**Before / after.** Before, `text: { text: "{$n} open tasks", values: … }`. After, `text: { message: "{$n} open tasks", values: … }`.

## Decisions

- **Rename the bound text's key, not the node's field.** The node's `text` is the same key on every node that shows words; renaming it would move the doubling onto every node instead of removing it.
- **`message`, the standard's word.** It is what MessageFormat 2 calls the pattern and what an author coming from FormatJS or i18next already writes.
- **Values stay beside their message, not on the node.** A node holding two texts — a menu and its items, a link and its press's label — would need a values map per text, and pairing them by name would bring the doubling back as a naming problem.
- **The wire is renamed too.** One shape spelled two ways would make a renderer author and a manifest author read different words for the same member.

## Verify

- `{ type: text, text: { message: "{$n} open tasks", values: { n: !cel "data.open" } } }` passes `telo check` and the page shows "3 open tasks" for `open: 3`, in a plural-aware translation.
- `{ message: "{$n} open", values: {} }` is `MESSAGE_PLACEHOLDER_UNBOUND`; `{ message: "{$n", values: { n: 1 } }` is `MESSAGE_SYNTAX_INVALID`; `values: { n: !cel "data.opne" }` is `CEL_UNKNOWN_FIELD`.
- `{ text: "{$n} open", values: { n: … } }` is `SCHEMA_VIOLATION` naming `message`, at `telo check` and when the resource is created.
- `message: { text: "{$n} open", context: dashboard }` translates through a catalog entry with that context.
- The page document carries `{ message: { text, context, lang, computed }, values }` for every bound text and no `text` member beside `values`; `ui-react`'s page tests and the conformance scenes pass.
- Every in-repo manifest, guide and primer example writing a bound text passes `telo check` with `message`.

## Bookkeeping

Docs: `ui` `texts.md`, `nodes.md` and every doc with a bound-text example; `ui-react`'s description of what it receives. Every in-repo manifest writing a bound text (`examples/ui-showcase`, `examples/chat`, the `ui` and `crud-ui` tests and fixtures), the hub `build-ui` guide, the authoring-agent primer, the Declarative UI paragraph of `modules/CLAUDE.md`, and the bound-text examples in the open UI plans as each is next edited. `Added` fragments describing the break for `ui` and `ui-react`. `telo release floor` with the change: an application writing `message` needs the `ui` release that reads it, by the grammar rule.
