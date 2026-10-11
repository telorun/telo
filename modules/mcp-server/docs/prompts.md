---
description: "Mcp.Prompts — passive bundle of prompt entries listed via prompts/list and rendered via prompts/get. Each entry maps a named prompt and its arguments to any Telo.Invocable handler via CEL adapters."
sidebar_label: Mcp.Prompts
---

# `Mcp.Prompts`

> Examples below assume `mcp-server` is imported as `Mcp`.

A passive bundle declaring prompts that any `Mcp.StdioServer` or
`Mcp.HttpEndpoint` can offer. Bundles are referenced from a transport's
`prompts:` array — several bundles compose into one transport, and one bundle
can serve several transports. A server advertises the `prompts` capability only
when it lists at least one bundle.

## Schema

```yaml
kind: Mcp.Prompts
metadata: { name: <BundleName> }
entries:
  - name: <prompt_id>                  # advertised to clients via prompts/list
    description: <text>                # optional
    arguments:                         # optional — flat list of named parameters
      - name: <argument>
        description: <text>
        required: true
    handler: <ref to a Telo.Invocable>
    inputs:                            # CEL: MCP request → handler input
      <handlerField>: !cel "request.arguments.<argument>"
    result:                            # CEL: handler output → GetPromptResult
      description: <text>              # optional
      messages:
        - role: user
          content:
            type: text
            text: !cel "result.<y>"
    catches:                           # optional — InvokeError → JSON-RPC error
      - code: <telo_error_code>
        when: !cel "<bool>"
        error:
          code: <jsonrpc_int>
          message: !cel "error.message"
```

## Arguments

MCP prompt arguments are strings, so `request.arguments` is a map of text. An
argument a client may leave out is read with a guard:

```yaml
inputs:
  focus: !cel "request.arguments.?focus.orValue('correctness')"
```

A `prompts/get` that leaves out an argument marked `required`, or names a prompt
no bundle declares, is answered with JSON-RPC error `-32602` and no handler
runs.

## CEL scopes

| Field      | Available                                                                 |
| ---------- | ------------------------------------------------------------------------- |
| `inputs:`  | `request.{name, arguments, meta, session.{id, clientInfo, capabilities}}` |
| `result:`  | `result` (handler output), `request.{name, arguments}`                    |
| `catches:` | `error.{code, message, data}`, `request.{name, arguments}`                |

## Result envelope

`result:` is the full MCP `GetPromptResult`:

| Field         | Required | Notes                                    |
| ------------- | -------- | ---------------------------------------- |
| `messages`    | yes      | Array of `{ role, content }` messages.   |
| `description` | no       | Shown by clients beside the prompt.      |
| `_meta`       | no       | MCP metadata passthrough.                |

A rendered `messages` that is not an array of objects each carrying a `role` and
a `content` block fails the request with `ERR_MCP_RESULT_INVALID`.

MCP carries binary as standard base64, so a bytes value at an image or audio
block's `data`, or at an embedded resource's `blob`, is sent that way. Every
other CEL value in the envelope is written in its plain encoding, as in a tool
result — see [Mcp.Tools](./tools.md).

## Duplicates

A name declared twice in one bundle, or by two bundles one transport lists, is
reported by `telo check` (`RESOURCE_RULE_VIOLATED`, rule `MCP_PROMPT_DUPLICATE`)
and refused at boot with `ERR_MCP_PROMPTS_DUPLICATE`.

## Limits

The listing is fixed at boot: there is no `listChanged` notification and no
`completion/complete` for argument values.
