---
description: "Yaml.Parse — Telo.Invocable that parses a UTF-8 YAML string into the JS values declared by each document. Multi-doc-aware."
sidebar_label: Yaml.Parse
---

# `Yaml.Parse`

> Examples below assume `yaml` is imported as `Yaml`.

Parses a UTF-8 YAML string into plain JavaScript values, one entry per
document. Single-document inputs land in `docs[0]`; multi-document inputs
preserve source order.

## Schema

```yaml
kind: Yaml.Parse
metadata: { name: <ResourceName> }
```

`Yaml.Parse` carries no configuration — every input is per-call.

## Inputs

| Field  | Type   | Required | Notes                          |
| ------ | ------ | -------- | ------------------------------ |
| `text` | string | yes      | UTF-8 YAML source to parse.    |

## Outputs

| Field  | Type        | Notes                                                                                                                                                                                                                                                       |
| ------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs` | `unknown[]` | One entry per non-empty document, in source order. Each entry mirrors the source document's top-level value — typically an object, but YAML permits scalars and arrays at the document root, so the schema is `items: {}` (any value). Empty input → `[]`. |

## Errors

`Yaml.Parse` raises `InvokeError` with `code: "ERR_PARSE_FAILED"` when the
input isn't valid YAML. The first parser error message is included; the full
error list (each with `message` and parser-supplied `code`) is preserved on
`error.data.errors` so downstream `catches:` blocks can inspect them.

## Behaviour

- **Multi-document files.** Documents separated by `---` are returned in source order. Empty documents (a `---` separator with no content) are skipped.
- **Empty input.** An empty string or whitespace-only input yields `{ docs: [] }` (no error).
- **Strict parsing.** Malformed YAML throws — there is no "lenient" mode that returns partial documents.

## Example: extract a field from the first doc

CEL's `has()` macro only walks `.`-field chains and rejects array indexing
in the path, so `has(steps.parse.result.docs[0].metadata)` would throw at
compile time. The kernel enables CEL's optional types
(see [yaml-cel-templating README](../../../yaml-cel-templating/README.md#11-cel-stdlib)),
which gives you `[?index]` for optional indexing and `.?field` for optional
access — chain them with `.orValue(default)` to land on a fallback when any
intermediate is missing:

```yaml
- name: parse
  invoke: { kind: Yaml.Parse }
  inputs:
    text: ${{ inputs.body }}
- name: record
  inputs:
    description: ${{ steps.parse.result.docs[?0].?metadata.?description.orValue(null) }}
  invoke: { ... }
```

Add a `type(...) == string` guard if you need to reject non-string values
(e.g. a publisher who supplies a YAML mapping where a string was expected):

```yaml
description: ${{ type(steps.parse.result.docs[?0].?metadata.?description.orValue('')) == string ? steps.parse.result.docs[?0].?metadata.?description.orValue(null) : null }}
```

## When to use this vs. the kernel's own loader

The kernel parses Telo manifests itself during boot — `Yaml.Parse` is for
runtime, in-handler use cases: extracting metadata from a published manifest,
validating a user-supplied YAML payload, etc. It does no semantic validation
of Telo kinds or schemas; it only returns whatever the YAML parser produces.
