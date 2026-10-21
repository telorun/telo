---
sidebar_label: Telo Formats
slug: /extend/telo-formats
description: "Declare a string field whose grammar Telo checks — a CSS selector, a language tag, a message pattern, a portable regular expression — with format:, refused by telo check on its own line and by the kernel at creation with the same reason."
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
| `language-tag` | A well-formed [RFC 5646](https://www.rfc-editor.org/rfc/rfc5646#section-2.1) language tag — language, extended language, script, region, variants, extensions, a private-use part, or a grandfathered tag — compared case-insensitively. Whether a subtag is registered is not checked. A module's `lang:` and a text catalog's `lang` are written in it. |
| `re2-pattern` | A regular expression [RE2](https://github.com/google/re2/wiki/Syntax) and an ECMAScript engine with the `u` flag both accept and match identically, as a closed allowlist: literal characters, escaped punctuation, `\t \n \r \f \v`, `\xHH`, `^ $ \b \B`, `\d \D \w \W`, classes with negation and ranges, `\p{…}` / `\P{…}` with a General_Category short name, `(…)` and `(?:…)`, `\|`, and `* + ? {n} {n,} {n,m}`, optionally lazy, with counts up to 1000. Everything else is refused by name with its position — lookaround, backreferences, named groups, inline flags, `.` and `\s` / `\S` (each engine matches a different set; write the class instead), `\u…`, `\x{…}`, `\cX`, `\0` and octal, `\pL`, scripts and long property names, POSIX classes, `\A \z \Z \Q \E \C`, and counts above 1000. |
| `message-pattern` | A [MessageFormat 2](https://www.unicode.org/reports/tr35/tr35-messageFormat.html#pattern) pattern in Telo's profile: literal text, placeholders `{$name}` (a name starts with a letter or `_`, continues with letters, digits or `_`, and is not a CEL reserved word) and the escapes `\{`, `\}`, `\\`. Literals, functions, options and markup in braces are outside the profile. A `Text` field is not typed by this format — its pattern is judged by the message core, so an unparsable one is `MESSAGE_SYNTAX_INVALID`; the format is for any other string slot holding a pattern. |

The vocabulary is closed and declared as data in `sdk/formats/`, one JSON
file per format, so every runtime accepts exactly the same strings. A `format:`
value that is neither a Telo format nor one JSON Schema defines is ignored by
the validators, as JSON Schema specifies.
