---
description: "Stream.Of: emit a declared list of literal items as a Stream, in order"
sidebar_label: Stream.Of
---

# Stream.Of

> Examples below assume this module is imported with an `imports:` entry under alias `Stream`. Kind references follow that alias — substitute your own if you import it under a different name.

Emits a declared list of literal `items` as a `Stream`, in order — the telo-native way to seed a pipeline with fixed data instead of an inline `JS.Script`. Value-agnostic: items pass through verbatim, so the element type is whatever the manifest declares.

---

## Example

```yaml
kind: Stream.Of
metadata: { name: Source }
items:
  - "hello telo"
```

Object items work the same way (e.g. seeding an AI-shape record stream):

```yaml
kind: Stream.Of
metadata: { name: Deltas }
items:
  - { type: text-delta, delta: "he" }
  - { type: text-delta, delta: "llo" }
```

---

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `items` | array | yes | Literal values to emit as a stream, in order. |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `output` | `Stream` | Stream of the declared items, in order. Statically opaque — pipe it whole into a consumer; member access past it is a static error. |
