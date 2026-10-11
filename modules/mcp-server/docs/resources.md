---
description: "Mcp.Resources — passive bundle of resource entries listed via resources/list and resources/templates/list and read via resources/read. Each entry maps a URI or a URI template to any Telo.Invocable handler via CEL adapters."
sidebar_label: Mcp.Resources
---

# `Mcp.Resources`

> Examples below assume `mcp-server` is imported as `Mcp`.

A passive bundle declaring readable resources that any `Mcp.StdioServer` or
`Mcp.HttpEndpoint` can advertise. Bundles are referenced from a transport's
`resources:` array — several bundles compose into one transport, and one bundle
can serve several transports. A server advertises the `resources` capability
only when it lists at least one bundle.

## Schema

```yaml
kind: Mcp.Resources
metadata: { name: <BundleName> }
entries:
  - uri: <scheme://fixed/uri>          # exactly one of uri / uriTemplate
    uriTemplate: <scheme://{var}/uri>  # RFC 6570
    name: <label>
    description: <text>                # optional
    mimeType: <type/subtype>           # optional — advertised in the listing
    handler: <ref to a Telo.Invocable>
    inputs:                            # CEL: MCP request → handler input
      <handlerField>: !cel "request.params.<var>"
    result:                            # CEL: handler output → ReadResourceResult
      contents:
        - uri: !cel "request.uri"
          mimeType: text/plain
          text: !cel "result.<y>"
    catches:                           # optional — InvokeError → JSON-RPC error
      - code: <telo_error_code>
        when: !cel "<bool>"
        error:
          code: <jsonrpc_int>
          message: !cel "error.message"
```

## Fixed URIs and templates

An entry declares exactly one of `uri` and `uriTemplate`; both or neither is a
`SCHEMA_VIOLATION`.

- A `uri` entry appears in `resources/list` and is read by that exact URI.
- A `uriTemplate` entry appears in `resources/templates/list`. A read whose URI
  matches the template reaches the entry with the template's variables as
  `request.params` (`weather://{city}/forecast` read as
  `weather://Oslo/forecast` gives `request.params.city == "Oslo"`).

A template must close every `{` and name a variable in it; one that does not is
a `SCHEMA_VIOLATION`. Matching is the MCP SDK's, which is narrower than RFC 6570
in two ways worth knowing: a variable arrives as it appears in the URI —
percent-encoding is not decoded, so `weather://New%20York/forecast` gives
`"New%20York"` — and a query expression (`{?q}`) matches only when every named
parameter is present, in order, with no others.

A read is matched against the fixed URIs first, then against the templates in
the order they are declared, and the first match wins. A URI nothing matches is
answered with JSON-RPC error `-32002`, carrying the URI in `data.uri`, and no
handler runs.

## CEL scopes

| Field      | Available                                                                |
| ---------- | ------------------------------------------------------------------------ |
| `inputs:`  | `request.{uri, params, meta, session.{id, clientInfo, capabilities}}`    |
| `result:`  | `result` (handler output), `request.{uri, params}`                       |
| `catches:` | `error.{code, message, data}`, `request.{uri, params}`                   |

## Result envelope

`result:` is the full MCP `ReadResourceResult`:

| Field      | Required | Notes                                                             |
| ---------- | -------- | ----------------------------------------------------------------- |
| `contents` | yes      | Array of `{ uri, mimeType?, text }` or `{ uri, mimeType?, blob }`. |
| `_meta`    | no       | MCP metadata passthrough.                                         |

A rendered `contents` that is not an array of objects each carrying a `uri`
fails the read with `ERR_MCP_RESULT_INVALID`.

**Binary contents.** MCP carries `blob` as standard base64. A bytes value at
`contents[].blob` is sent that way, so a handler returning bytes needs no
encoding step:

```yaml
result:
  contents:
    - uri: !cel "request.uri"
      mimeType: image/png
      blob: !cel "result.bytes"
```

Every other CEL value in the envelope is written in its plain encoding, as in a
tool result — see [Mcp.Tools](./tools.md).

## Duplicates

A URI or template declared twice in one bundle, or by two bundles one transport
lists, is reported by `telo check` (`RESOURCE_RULE_VIOLATED`, rule
`MCP_RESOURCE_DUPLICATE`) and refused at boot with `ERR_MCP_RESOURCES_DUPLICATE`.

## Limits

The listings are fixed at boot: there is no `resources/subscribe`, no
`listChanged` notification and no `completion/complete` for template variables.
