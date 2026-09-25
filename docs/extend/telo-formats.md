---
sidebar_label: Telo Formats
slug: /extend/telo-formats
description: "Declare a string field whose grammar Telo checks — a CSS selector — with format: css-selector, refused by telo check on its own line and by the kernel at creation with the same reason."
---

# Telo formats

A **Telo format** is a JSON Schema `format:` value whose grammar Telo checks.
A kind declares one in the ordinary spelling:

```yaml
schema:
  type: object
  properties:
    selector:
      type: string
      format: css-selector
```

The value stays a plain string — in CEL, on the wire, to the controller. Only
the text it may hold is narrowed, and that is checked everywhere a value is
validated: a resource's own configuration, a call's `inputs:` against the
invoked kind's `inputType`, an `outputType`, observed state.

## What a refusal says

A value outside the grammar is refused with the checker's reason — where it
stopped and what it expected — not with `must match format "css-selector"`:

```text
/selector must be a css-selector: Expected attribute name at offset 3 of "div["
```

`telo check` reports it as `SCHEMA_VIOLATION` on the field's own line (at a
call's `inputs:`, as `CONTRACT_INPUTS_MISMATCH`), and the kernel refuses the
same value at creation (or dispatch) with the same text.

## Expressions

What a `!cel` expression or an `!interpolate` template yields is known only
once it is evaluated, so `telo check` does not refuse one at a Telo format slot:

```yaml
selector: !cel "variables.selector"
```

The kernel checks the result instead — at creation for a compile-time field,
and at dispatch for a call's `inputs:` — with the same reason as above. A
field marked `x-telo-eval: runtime` is evaluated by the controller itself, so
its result is not checked against the format.

`telo check` still types the expression: one that yields something other than a
string is `CEL_TYPE_ERROR`. A `dyn` expression passes that check, so at creation
the kernel also refuses a result that is not a string at all
(`ERR_RESOURCE_SCHEMA_VALIDATION_FAILED`, naming the field by JSON Pointer).

## The formats

| Format | Accepts |
| --- | --- |
| `css-selector` | A [Selectors Level 4](https://www.w3.org/TR/selectors-4/#typedef-complex-selector-list) `<complex-selector-list>` in the snapshot profile: no pseudo-elements (`p::before`), no namespace prefixes (`svg\|a`), no leading combinator (`> a`). `:scope` names the element the selector is matched from, so a selector relative to it is written `:scope > a`. A relative selector (`+ p`) is valid only inside `:has()`, which does not nest; `:nth-child(An+B of S)` takes a selector list. State and user-action pseudo-classes (`:hover`) are valid syntax. |

The vocabulary is closed and declared as data in `analyzer/formats/`, one JSON
file per format, so every runtime accepts exactly the same strings. A `format:`
value that is neither a Telo format nor one JSON Schema defines is ignored by
the validators, as JSON Schema specifies.
