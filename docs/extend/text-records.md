---
sidebar_label: Reading a Text
slug: /extend/text-records
description: "Declare a field or a function parameter that holds text shown to a person, and read the record the runtime hands your controller: the message as written, its context, the language it is written in, and whether it was computed."
---

# Reading a `Text`

A field or a function parameter that holds **text shown to a person** is typed by
the built-in `Text` fragment:

```yaml
schema:
  type: object
  properties:
    label: { $ref: "telo://manifest#/$defs/Text" }
```

An author writes a `Text` as a message, or as a message with a context:

```yaml
label: "{$count} files"                       # a pattern
label:                                        # a plural selection
  plural: count
  cases: { "=0": "No files", one: "{$count} file", other: "{$count} files" }
label: { text: Open, context: verb }          # the same words, told apart
```

A message is a [MessageFormat 2](https://www.unicode.org/reports/tr35/tr35-messageFormat.html)
pattern in Telo's profile — literal text, `{$name}` placeholders and the escapes
`\{`, `\}`, `\\` — or a selection `{ plural: <name>, cases }` whose cases are
messages, `other` required and `=N` cases matched before the
[CLDR plural categories](https://cldr.unicode.org/index/cldr-spec/plural-rules).
`telo://manifest#/$defs/Message` types a slot holding a message alone, and
`telo://manifest#/$defs/TextCatalog` a slot holding translations — a kind whose
whole `schema:` is that fragment holds one catalog, written beside `kind` and
`metadata`. A catalog is always written: an expression inside one, at its slot,
or above it — a list of catalogs computed whole — is refused, by `telo check` and
again before the resource is created. A bare `self.<path>` a template body or a
`base:` mapping forwards is not computed: it hands on what the consumer wrote.

## What your controller receives

Your controller never sees the text as written. The runtime hands it a **text
record** — the same shape in every runtime and over every wire:

```ts
import { type TextRecord } from "@telorun/sdk";

interface TextRecord {
  text: MessageSource;        // the message as written: a pattern, or { plural, cases }
  context: string | null;     // null when none is written
  lang: string;               // the language the text is written in
  computed: boolean;          // true when an expression produced it
}
```

- **`lang`** is the `lang:` of the module that WROTE the text, `und` when that
  module declares none. That is not always the module declaring the resource: a
  template's own literal is its library's, and a value a template or a `base:`
  mapping forwards with a bare `self.<path>` is the consumer's.
- **`computed`** is true when an expression produced the text. A computed text is
  never looked up in a catalog — there is no source text to look it up by.

A text in a field your controller evaluates itself — one marked
`x-telo-eval: runtime`, or one a CEL region (`x-telo-context`) covers — arrives
the same way: `ctx.expandValue` returns each `Text` the evaluation produces as a
record, `computed: true`, judged in the language of the module that wrote the
expression, and checks the values the same evaluation produces for it. A literal
written there is already a record and comes back unchanged.

Read the message with the core the SDK re-exports — `readMessage(record.text)`,
`formatMessage(message, lang, values)`, `textIdentity` for the key a catalog
looks it up by, `lookupLanguage` for the language a translation is chosen in — so
every controller formats through the same rules.

## A `Text` parameter

A function parameter typed `Text` takes a text **written at the call**, never an
expression; a native function receives it as a record attributed to the module
whose expression makes the call:

```yaml
params:
  - name: text
    schema: { $ref: "telo://manifest#/$defs/Text" }
  - name: values
    optional: true
    schema: { type: object, x-telo-text-values-for: /text }
```

`x-telo-text-values-for: <JSON Pointer>` names the `Text` the object holds the
values of — relative to the object holding the annotated field, or for a parameter
to the arguments keyed by parameter name. Every placeholder and selector the text
reads must be a key, a value must be a string or a number, and a selector a
number. Values a call writes are checked before the app runs; values an
expression computes are checked when the call is made, before your function runs.
A function whose body is CEL reads the text as written.

## Values named per row

A field your controller resolves for its own consumer — `x-telo-eval: accessor`,
never evaluated — cannot hold a text: the kind is refused (`TEXT_SLOT_ACCESSOR`),
since such a field reaches your controller as a binding. Give the text a field of
its own and name its values by accessor instead:

```yaml
values:
  type: object
  x-telo-text-values-for: /label
  x-telo-context: { type: object, properties: { row: { $ref: "#/$defs/Row" } } }
  additionalProperties: { x-telo-eval: accessor }
```

Each entry arrives as its binding — `{ value }` for a literal, `{ root, path }`
for a chain — and is checked as the value it is: a literal as written, a chain
as the type `telo check` gives it.

## Texts formatted by someone else

When whoever shows a text formats it with values of its own — a renderer
formatting a label in the browser, a controller formatting a message it builds —
state those values on the text's node with `x-telo-text-values: { <name>: <schema> }`,
each schema a `string`, `integer` or `number`:

```yaml
minLength:
  $ref: "telo://manifest#/$defs/Text"
  x-telo-text-values: { limit: { type: integer } }
heading:
  $ref: "telo://manifest#/$defs/Text"
  x-telo-text-values: {}            # formatted with no values at all
```

A text written there may read only those placeholders, and select a plural case
only over a number: `Must be at least {$limit} characters` is accepted, `Hello
{$name}` is `MESSAGE_PLACEHOLDER_UNBOUND`, a selection over a string value
`MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED` — checked before the app runs for a text
as written, and when the text is produced for one an expression computes. The
annotation sits on a `Text` or `Message` node only, its values are
`string` / `integer` / `number` schemas, and a text a sibling already binds
through `x-telo-text-values-for` takes none of its own — anything else is
`TEXT_VALUES_INVALID`, reported at the kind and again when the kernel registers
it. A text with neither annotation is not judged for its placeholders.

## Texts inside a union

A field may admit a text or something else — `anyOf: [Text, { text, values }]`,
a text or a reference. A value is a text only where the `Text` branch admits it:
a string, or an object holding exactly a closed branch's members. Anything else
is judged by its own branch, and an expression is evaluated first and judged as
whatever it produced.

## Records on a wire

A kind that hands text records on — in its output, or in a document it serves —
types them with `telo://manifest#/$defs/TextRecord`: the closed object
`{ text, context, lang, computed }` your controller received. A record there is
data that has already been judged: it is not judged again, looked up in a
catalog or counted as a text its module shows.

## Schema texts

The `title`, `description` and string `enum` values of a data schema — a named
shape, a contract, a `status:` block, a function's parameters — are texts too:
they are looked up in a catalog by their words, but reach no controller as a
record. `x-telo-text-context: "<context>"` on a schema node gives that node's
texts a context.

## Catalog sets

A kind that looks texts up in several catalogs — a translator listing a base
catalog and a language pack — marks where they are gathered with
`x-telo-text-catalog-set: true` on a node of its `schema:`:

```yaml
schema:
  type: object
  properties:
    catalogs:
      type: array
      x-telo-text-catalog-set: true
      items:
        x-telo-ref: { kind: Self.Catalog, use: dependency }
```

The catalogs at and beneath the node form one lookup set: every `TextCatalog`
written there, and the catalogs in the configuration of each resource a
reference there names — continuing through the catalog sets that resource's own
kind marks. A resource reached twice is one member. Across the set, one text and
context may be translated once per language: a duplicate — a nested plural source
and the plain pattern its `other` cases lead to are one text, `{ $n }` and `{$n}`
one placeholder, `pl` and `PL` one language — is refused at the reference (or the
inline catalog) bringing in the later one, by `telo check` — for a resource
declared at the top level, in a `with:` scope or as an entry of a template body,
where what a consumer forwards with a bare `self.<path>` joins what the entry
writes and is reported where the consumer wrote it — and again before your
controller is created. The mark must be `true`, must reach a catalog or a
reference slot, and must not sit inside another catalog set.

## What is checked

| Code | When |
| --- | --- |
| `MESSAGE_SYNTAX_INVALID` | a message does not parse |
| `MESSAGE_PLURAL_CATEGORY_INVALID` | a selection names a category its language lacks |
| `MESSAGE_SOURCE_LANGUAGE_MISSING` | a text selects a plural case and its module declares no `lang:` |
| `MESSAGE_PLACEHOLDER_UNKNOWN` | a translation reads a placeholder its source lacks |
| `MESSAGE_PLACEHOLDER_UNBOUND` | a message's values lack a name it reads, or it reads a name its slot's `x-telo-text-values` does not declare |
| `MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED` | a value is neither a string nor a number, or a selector's is not a number |
| `MESSAGE_ENTRY_COMPUTED` | a catalog holds an expression, or an expression produces one |
| `MESSAGE_ENTRY_DUPLICATE` | a catalog, or a catalog set, translates one text and context twice in one language |
| `TEXT_ARGUMENT_COMPUTED` | a `Text` parameter's argument is an expression |
| `TEXT_VALUES_FOR_INVALID` | a values pairing names nothing, no `Text`, or a `Text` already paired |
| `TEXT_SLOT_ACCESSOR` | a kind types a text at or beneath an accessor field |
| `TEXT_VALUES_INVALID` | `x-telo-text-values` on a node that is no text, a value schema other than `string` / `integer` / `number`, or on a text a values pairing binds |
| `TEXT_CATALOG_SET_INVALID` | a catalog set marks a node reaching no catalog and no reference, or sits inside another |
| `MESSAGE_TEXT_UNUSED` (warning) | a catalog entry matches no text its module's imports show |
| `TEXT_CONTEXT_MISPLACED` (warning) | `x-telo-text-context` where nothing reads it |

`telo check` reports each where it is written; the runtime refuses the same
mistakes as `ERR_<code>` — for a text or values computed at creation or when your
controller evaluates them, and for a dependency's own texts, which `telo check`
of your application does not judge.

The Rust kernel builds no text records yet, and refuses a resource whose kind
holds a `Text` or marks a catalog set.
