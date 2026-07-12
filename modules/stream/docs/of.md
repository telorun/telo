---
description: "Stream.Of: emit a list of items as a Stream, in order — declared statically or supplied at invoke time"
sidebar_label: Stream.Of
---

# Stream.Of

> Examples below assume this module is imported with an `imports:` entry under alias `Stream`. Kind references follow that alias — substitute your own if you import it under a different name.

Emits an `items` array as a `Stream`, in order — the telo-native way to seed a pipeline with data instead of an inline `JS.Script`. Items may be **declared statically** as a resource field or **passed as invoke inputs** to emit values computed at request time. Value-agnostic: items pass through verbatim, so the element type is whatever the manifest declares.

---

## Example — static items

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

## Example — runtime items

Pass `items` as invoke inputs to stream a value computed at request time. This is
the read-through-cache pattern: a route in `mode: stream` whose handler must
return a stream on every branch can emit a stored value as a stream on the cache
hit. Runtime inputs take precedence over the statically-declared `items` (a
default); when neither is present the stream is empty.

```yaml
kind: Run.Sequence
metadata: { name: ServeCached }
steps:
  - name: Emit
    invoke: !ref Cached
    inputs:
      items: !cel "[cachedValue]"
```

```yaml
kind: Stream.Of
metadata: { name: Cached }
# no static `items` — supplied at invoke time
```

---

## Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `items` | array | no | Literal values to emit as a stream, in order. A static default, overridden by runtime invoke inputs. |

## Inputs

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `items` | array | no | Runtime values to emit as a stream, in order. When provided, overrides the statically-declared `items`. |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `output` | `Stream` | Stream of the items, in order. Statically opaque — pipe it whole into a consumer; member access past it is a static error. |
