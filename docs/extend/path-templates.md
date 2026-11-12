---
sidebar_label: Path Templates
slug: /extend/path-templates
description: "Let a kind take an address as a path template plus a map of its variables, and have every misspelt or missing variable refused before the app runs."
---

# Path templates

An address is often written as a template and the values that fill it:
`/conversations/{id}` and `{ id: row.id }`. Nothing in JSON Schema relates the
two, so a variable the map never binds, or an entry named after a variable the
template does not have, would only show up as a wrong link at run time.

`x-telo-path-params-for` is the annotation that relates them. It sits on the map
of variables and names the field holding the template; `telo check` holds each
key of the map to the template's variables, and the kernel refuses the same
resource when it creates it.

## Declaring one

```yaml
kind: Telo.Definition
metadata:
  name: Link
capability: Telo.Provider
schema:
  type: object
  properties:
    href:
      type: object
      required: [path]
      properties:
        path: { type: string }
        pathParams:
          type: object
          additionalProperties: { type: string }
          x-telo-path-params-for: { template: /path }
```

- `template` is a JSON Pointer, relative to the object holding the annotated
  map, to the field holding the template (`/path` — the sibling `path`).
- `through` (optional) names the field holding the template on the declaration a
  REFERENCE at that field names — a field name (`path`) or a JSON Pointer
  (`/route/path`). Write it exactly when the template field may hold a `!ref`.

The annotation works at any depth: in a list item, a map value, a union branch,
and inside a named shape the kind's schema reaches by `$ref` to the shape or a
JSON Pointer into it — recursive shapes included — so a node tree's addresses
are checked wherever they sit.

## The template

A template is an app-relative path (`/conversations/{id}`) or an `https://`,
`http://` or `mailto:` address. A variable is a whole path segment, `{<name>}`
between two `/` (or at the end), and `<name>` is a Telo name
(`^[A-Za-z_][A-Za-z0-9_]*$`) written once. For an absolute URL only the segments
after the authority are variables; the authority, the query and the fragment
hold none.

| Written | Read as |
|---|---|
| `/x/{id}` | one variable, `id` |
| `https://example.com/{org}/repos` | one variable, `org` |
| `mailto:{address}` | one variable, `address` |
| `/x/a{id}` | refused: the variable shares its segment with text |
| `/x/{id}/{id}` | refused: `id` is written twice |
| `https://{host}/x` | refused: a variable in the authority |

## What the template field may hold

- **A literal template** — read as above.
- **A reference**, with `through` — the template is the named field of the
  declaration the reference names, read from the declaration as written, so
  renaming that declaration's path moves every address naming it with no other
  edit. Declare the slot `x-telo-ref: { kind: <Kind>, use: schema }` — a
  declaration read — beside the literal branch in an `anyOf`.
- **An expression** — a whole address read from data. It is never expanded, so
  every entry of the map is unused and refused: drop the map, or write the
  template.

An omitted map binds nothing, so it reads as `{}`: every variable of the
template is unbound. A value that is still undecided — a reference naming
nothing the checker can read — is left alone.

## What is refused

| Code | When |
|---|---|
| `PATH_TEMPLATE_INVALID` | The template field holds a brace that is not a whole segment, an invalid or repeated name, or a variable in an absolute URL's authority. Reported at the template field. |
| `PATH_PARAMETER_UNBOUND` | The template reads `{name}` and the map has no entry `name`. Reported at the template field. |
| `PATH_PARAMETER_UNUSED` | An entry of the map names no variable of the template — every entry, when the template field holds an expression. Reported at the entry. |
| `PATH_PARAMS_FOR_INVALID` | The annotation is malformed (not `{ template, through? }`, `template` not a JSON Pointer), sits anywhere but on a named property declared `type: object`, names a field the holding object does not declare, or writes `through` beside a field that holds no reference (or omits it beside one that may). Reported at the kind; a dependency's at the `imports:` entry reaching it. |

The kernel raises the first three as `ERR_PATH_TEMPLATE_INVALID`,
`ERR_PATH_PARAMETER_UNBOUND` and `ERR_PATH_PARAMETER_UNUSED` when it creates the
resource — `telo check` reports them only for the entry's own modules, so a
dependency's resource is refused there — and `ERR_PATH_PARAMS_FOR_INVALID` when
it registers the kind. Both halves read one implementation, so they agree.
