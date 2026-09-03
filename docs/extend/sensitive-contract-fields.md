---
sidebar_label: Sensitive Contract Fields
slug: /extend/sensitive-contract-fields
description: "Mark an inputType / outputType field with x-telo-sensitive so a token or credential is carried as [redacted] on the debug wire instead of verbatim — and why the annotation is reported when written anywhere it would not be read."
---

# Marking a contract field sensitive

A resource's invoke **inputs and outputs ride the debug wire on every call** under
`--inspect` — which is every watch session. Nothing scrubs them: the kernel's
substring scrubbing has one call site, the resource-Created event's properties, and
log attributes match on exact values.

That was survivable while a credential was a held instance whose material never
crossed a dispatch boundary. It stops being survivable the moment auth is a
dispatched `Telo.Invocable`, because the token becomes an invoke **output**.

## The annotation

Mark the contract property that carries the value:

```yaml
outputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    properties:
      headers:
        type: object
        additionalProperties: { type: string }
        x-telo-sensitive: true
```

The kernel then carries that value as `[redacted]` in trace payloads. The **key is
kept and only the value replaced** — a payload that silently loses a key reads as a
value that was never produced.

## Where it is read from

**Only `inputType` and `outputType`.** It is the one annotation read from a *data*
schema rather than from a kind's own `schema:`, because a contract is what the kernel
binds and validates at dispatch.

Written on a kind's configuration it is an unknown keyword in an open schema: it
validates, it ships, and it does nothing. For a security control that is the worst
available failure — an author marks a token, sees no error, and puts it on the wire
anyway — so a misplacement is an error (`SENSITIVE_ANNOTATION_MISPLACED`) rather than
a silence.

## What the walk covers

- **A property**, by name.
- **A map's values** — `additionalProperties` / `patternProperties`. A headers or
  query bag carries no property names to walk, so without this the whole bag is
  emitted verbatim.
- **Array elements**, through `items`.
- **The whole value**: marking the contract's root is legal. A contract whose entire
  output is the secret is the simplest shape there is.

A marked node is redacted whole, so nothing below it is walked.

## Declare it on the abstract

Mark it where the contract is *owned*, so every implementation inherits it rather than
each one remembering. `Http.Credential` marks its own `headers` and `query` — inbound
as well as outbound, since the request handed to a credential already carries the
client's default headers.

## What it does not cover

A thrown error's structured `data` is **not** redacted. `ERR_HTTP_STATUS` carries up
to 8 KB of provider response body there by design, so do not put a credential in an
error's data and expect this to hide it.

A contract that cannot be resolved withholds the payload **whole** rather than
guessing — the dispatch that follows raises that same failure with its own code, so
nothing is swallowed.
