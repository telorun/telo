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

## Patterns are RE2

A schema's `pattern`, the keys of its `patternProperties` and `format: regex`
are read as [RE2](https://github.com/google/re2/wiki/Syntax) wherever a value
is validated — by `telo check`, by the kernel, and by a transport's request
validator — never as the host's own regular expressions. RE2 matches in time
linear in the text, so no pattern can hang a validation, and every runtime reads
a pattern the same way. A match is a search: anchor it with `^` and `$` to hold
the whole value.

A pattern RE2 cannot read is refused before the app runs wherever a schema is
written: a kind's `schema:`, `status:`, `inputType:` and `outputType:`, a
`throws.codes` entry's `data:`, a `Telo.JsonSchema`, an Application's or a
Library's `variables:` and `secrets:` entries, and a field a module declares as
JSON Schema. Every such position is typed by the shared fragment
`telo://manifest#/$defs/JsonSchema7` (a kind's `schema:` by `KindSchema`), which
is Telo's meta-schema: it declares `pattern` and every `patternProperties` key as
`format: regex` at every place the draft-07 meta-schema places a schema. So
`telo check` reports the refusal as `SCHEMA_VIOLATION` at the pattern — at the
`patternProperties` object for a key, naming the key — and the kernel refuses
the load with the same finding:

```text
/schema/properties/code/pattern invalid RE2 pattern "^(?!tmp$)[a-z]+$": invalid or unsupported Perl syntax
```

A module field that holds JSON Schema says so the same way, with
`$ref: "telo://manifest#/$defs/JsonSchema7"` — a field a kind takes through
`x-telo-schema-from` included, where the refusal is reported as
`DEPENDENT_SCHEMA_MISMATCH`, the code every mismatch at such a field carries,
with the same sentence. A schema that reaches a validator
some other way is still judged when it is compiled: every pattern it holds,
wherever it sits — in a `definitions` entry nothing references, under `not`,
`if` / `then` / `else` or `dependencies`, as a `patternProperties` key whose
schema accepts everything — is refused with the same sentence, naming its place.
A `default:` or `const:` beside `format: regex` is a value, not a pattern of the
schema, and is not judged when it is compiled. `format: regex` accepts exactly
the patterns RE2 reads; a value it refuses is explained with the same sentence.

What RE2 reads differently from an ECMAScript engine:

| Construct | RE2 |
| --- | --- |
| `.` | Any character but a line feed — a carriage return, U+2028 and U+2029 included. Write the class you mean: `[^\n\r]`. |
| `\s` | `[\t\n\f\r ]` only: no vertical tab, no no-break space, no other Unicode space. |
| `\S` | Everything `\s` does not match, so a no-break space is `\S`. |
| `\p{…}` | A general category (`\p{L}`, `\p{Lu}`) or a script (`\p{Greek}`); long names such as `\p{Letter}` are refused. |
| `\x{…}` | A code point by number: `\x{41}`, `\x{1F600}`. `\uXXXX` and `\cX` are refused. |
| `(?=…)` `(?!…)` `(?<=…)` `(?<!…)` | Refused: RE2 has no lookaround. |
| `\1` | Refused: RE2 has no backreferences. |

What a lookahead excluded is written as a positive pattern beside a `not:` —
here, a name that looks like an identifier and is not a reserved word:

```yaml
type: string
pattern: "^[A-Za-z_][A-Za-z0-9_]*$"
not: { enum: [if, else, while] }
```

A name a `patternProperties` key must exclude gets a key of its own whose schema
is `false`: `"^_telo": false` beside `"^[A-Za-z_][A-Za-z0-9_]*$": { … }`.

The `re2-pattern` format below is a different question: it accepts only a
pattern RE2 and an ECMAScript engine would match identically, for a value a
module hands to both.

## The formats

| Format | Accepts |
| --- | --- |
| `css-selector` | A [Selectors Level 4](https://www.w3.org/TR/selectors-4/#typedef-complex-selector-list) `<complex-selector-list>` in the snapshot profile: no pseudo-elements (`p::before`), no namespace prefixes (`svg\|a`), no leading combinator (`> a`). `:scope` names the element the selector is matched from, so a selector relative to it is written `:scope > a`. A relative selector (`+ p`) is valid only inside `:has()`, which does not nest; `:nth-child(An+B of S)` takes a selector list. State and user-action pseudo-classes (`:hover`) are valid syntax. |
| `language-tag` | A well-formed [RFC 5646](https://www.rfc-editor.org/rfc/rfc5646#section-2.1) language tag — language, extended language, script, region, variants, extensions, a private-use part, or a grandfathered tag — compared case-insensitively. Whether a subtag is registered is not checked. A module's `lang:` and a text catalog's `lang` are written in it. |
| `re2-pattern` | A regular expression [RE2](https://github.com/google/re2/wiki/Syntax) and an ECMAScript engine with the `u` flag both accept and match identically, as a closed allowlist: literal characters, escaped punctuation, `\t \n \r \f \v`, `\xHH`, `^ $ \b \B`, `\d \D \w \W`, classes with negation and ranges, `\p{…}` / `\P{…}` with a General_Category short name, `(…)` and `(?:…)`, `\|`, and `* + ? {n} {n,} {n,m}`, optionally lazy, with counts up to 1000. Everything else is refused by name with its position — lookaround, backreferences, named groups, inline flags, `.` and `\s` / `\S` (each engine matches a different set; write the class instead), `\u…`, `\x{…}`, `\cX`, `\0` and octal, `\pL`, scripts and long property names, POSIX classes, `\A \z \Z \Q \E \C`, and counts above 1000. |
| `package-url` | A well-formed [Package URL](https://github.com/package-url/purl-spec/blob/main/PURL-SPECIFICATION.rst) that names a package and no version: the `pkg:` scheme, a lower-case type, optional namespace segments and a name, each percent-encoded, then optional qualifiers and a subpath. An `@` marks a version, so one is refused; a literal `@` in a name is `%40` (`pkg:npm/%40napi-rs/canvas`). A `vcs_url` qualifier is refused too, naming the purl without it: the repository and commit are declared beside the package URL as `vcs: { url, revision }`. |
| `cpe` | A [CPE 2.3](https://nvlpubs.nist.gov/nistpubs/Legacy/IR/nistir7695.pdf) formatted string: `cpe:2.3:` and eleven attributes, 13 colon-separated fields in all, each `*`, `-` or text with backslash-escaped punctuation. |
| `vcs-url` | A git repository's location in the [SPDX](https://spdx.github.io/spdx-spec/v2.3/package-information/#77-package-download-location-field) and purl VCS notation, without a revision: `git+https://`, a host, an optional `:port` and a path of non-empty segments (`git+https://github.com/sqlite/sqlite`). No user name or password, no `@`, no query, no fragment. |
| `vcs-revision` | A full commit id: exactly 40 (SHA-1) or 64 (SHA-256) lower-case hexadecimal digits. A tag, a branch and an abbreviated id are refused. |
| `path-template` | An [RFC 6570](https://www.rfc-editor.org/rfc/rfc6570) template narrowed to the [path templates](path-templates.md) Telo reads: an app-relative path, or an `http`, `https` or `mailto` address, whose variables are whole path segments `{name}`, each a name (`^[A-Za-z_][A-Za-z0-9_]*$`) written once. An absolute URL's authority, a query and a fragment hold none. |
| `message-pattern` | A [MessageFormat 2](https://www.unicode.org/reports/tr35/tr35-messageFormat.html#pattern) pattern in Telo's profile: literal text, placeholders `{$name}` (a name starts with a letter or `_`, continues with letters, digits or `_`, and is not a CEL reserved word) and the escapes `\{`, `\}`, `\\`. Literals, functions, options and markup in braces are outside the profile. A `Text` field is not typed by this format — its pattern is judged by the message core, so an unparsable one is `MESSAGE_SYNTAX_INVALID`; the format is for any other string slot holding a pattern. |

The vocabulary is closed and declared as data in `sdk/formats/`, one JSON
file per format, so every runtime accepts exactly the same strings. A `format:`
value that is neither a Telo format nor one JSON Schema defines is ignored by
the validators, as JSON Schema specifies.
