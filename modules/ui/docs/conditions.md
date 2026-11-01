# Conditions

What a page shows can depend on data the browser holds — a record a
[`Ui.Data`](data.md) read, a query parameter in the address, what a form holds
now. A **condition** says so as data: it names a value and a schema the value
must satisfy, and the renderer decides it in the browser, with no expression
engine there.

```yaml
shown:
  at: !cel "data.authorized"
  matches: { const: true }
```

## `when` and `shown`

Two keys, two moments:

| Key | Decided | Reads | Means |
| --- | --- | --- | --- |
| `when` | on the server — per request on a page's own nodes, once at creation inside a composite | evaluated CEL: `request` (on a page), `variables`, `resources` | whether the node is **delivered**: one that is not is not sent and has no state |
| `shown` | in the browser, whenever what it reads changes | the roots the place it is written binds | whether a delivered node is **drawn** |

Both may sit on one node. `when` never reads a browser root, and `shown` never
reads `request` — `telo check` refuses either (`CEL_UNKNOWN_IDENTIFIER`).

Content whose `shown` does not hold stays mounted, out of sight: a form keeps
what was typed, a listing keeps its page, and nothing inside starts a request. A
reload that a [reader](data.md) is asked for while hidden is remembered and
read once when it is shown; a request already in flight completes into the kept
state. Hiding and disabling are inverted with `not`.

## `Ui.Condition`

`{ at, matches }`, both required:

- `at` — an [accessor](https://telo.run/docs/extend/accessor-fields): a plain
  chain rooted at one of the roots in scope (`data.status`, `query.signin`,
  `values.kind`), or a fixed value. Anything else is `ACCESSOR_NOT_PLAIN_CHAIN`;
  a member the root does not declare is `CEL_UNKNOWN_FIELD`.
- `matches` — a schema in the interpreted profile, below. One that can never
  hold for the type `at` reads — `const: billing` against an integer, a `type`
  the value cannot have — is `MATCH_UNSATISFIABLE` at `telo check`, and the
  application holding it is refused at start.

**A missing value never satisfies a condition, even under `not`.** `null` is a
present value. Test for absence at the parent: a condition over `data` with
`matches: { not: { required: [email] } }` holds when the record has no
`email`.

## The interpreted profile

`Ui.Match` is the closed keyword set a renderer interprets as data — for
conditions and for a form's validation alike:

| Keywords | |
| --- | --- |
| `type`, `const`, `enum` | what the value is |
| `not`, `allOf`, `anyOf` | combinations |
| `required`, `properties` | an object's members (members present only) |
| `items`, `minItems`, `maxItems`, `uniqueItems` | a list (`items` is one schema) |
| `minLength`, `maxLength`, `pattern` | a string; lengths count characters, `pattern` is an [`re2-pattern`](https://telo.run/docs/extend/telo-formats) searched in the text |
| `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` | a number |

Any other keyword (`if`, `format`, `$ref`, …) is a `SCHEMA_VIOLATION` where it
is written. `pattern` is held to the subset RE2 and a browser match alike, so
`.` and `\s` are refused — write an explicit class (`[^\n]`, `[ \t]`).

What each keyword means is pinned by the rows in
[`conformance/match.json`](../conformance/match.json), which ship with the
module: each row is a schema, a value — or `missing: true` — and whether a
condition over them holds. A renderer answers every row; `ui-react`'s tests
read the file.

## Roots

A root is in scope only where the resource being written binds it. A composite
placed by `!ref` — or inline, which is extracted into a resource of its own —
sees only the roots its own kind binds, never those of the tree it is placed
in.

| Root | Where |
| --- | --- |
| `data` | inside a [`Ui.Data`](data.md)'s `content`, typed from its `model` |
| `error` | inside a `Ui.Data`'s or a [`Ui.Action`](action.md#the-answer)'s `failure`: a `Ui.RequestError` |
| `result` | inside an action's `result`, and its `onSuccess.navigate`: the answer, typed from `outputModel` |
| `input` | inside an action's `result` and `failure`: the record sent, typed from `inputModel` |
| `query` | wherever the resource or the page declares `query:` (a page, a reader, a listing's row actions); with none declared it is closed and empty |
| `values` | a form's or an action's field `shown`, an action's `enabled`, its `result` and `failure`, typed from the model |
| `row` | a `list` node's column and row actions, a listing's row actions and layouts; typed as an element of what the list's `rows` names, or from the listing's model |

Every root is read only by what is named — a condition's `at`, a `value` or
`list` node, a reader's `source.params` — and never by an expression the
server evaluates: `!cel "data.x"` in a `text` is `CEL_UNKNOWN_IDENTIFIER`.

## Query parameters

`Ui.QueryParameters` declares the query parameters a page or a reader reads,
each a string schema, or a list of strings for a key given more than once:

```yaml
query:
  signin: { type: string, enum: [denied, expired] }
  tag: { type: array, items: { type: string } }
```

An entry is a `Ui.Match` over `type: string` or `type: array` of strings. A
name is a Telo name — letters, digits and `_`, not a CEL keyword — and does not
begin `_telo`, which the renderer keeps for the keys it writes itself. In the
browser a parameter the address leaves out is missing, a scalar given more than
once counts as missing, and a value its declaration refuses is missing.

## Enablement

`Ui.Enablement` is a condition plus the reason shown while it does not hold:
`{ at, matches, disabledText }`, all three required. On a
[`Ui.Action`](action.md) it decides whether the button can be pressed, over the
form's `values`; on a [row action](action.md#row-actions), whether that row's
button can be, over `row` and the roots in scope — the action's own `enabled`
never governs a row.

```yaml
enabled:
  at: !cel "values.email"
  matches: { type: string, minLength: 3 }
  disabledText: Enter an address first.
```

## What a renderer receives

A condition is carried unchanged: `{ at, matches }`, `at` a binding —
`{ root, path }` for a chain, `{ value }` for a literal. An enablement carries
`disabledText` beside them.
