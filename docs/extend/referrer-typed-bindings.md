---
sidebar_label: Referrer-Typed Bindings
slug: /extend/referrer-typed-bindings
description: "Type a CEL binding from whoever references the resource, and say where it may be null, so telo check refuses an unguarded read where some referrer makes it null."
---

# Referrer-typed bindings

Some values in a kind's CEL context are decided by the resource that
**references** it, not by the kind. A field kind does not know which form lists
it, but its `values` binding is that form's record. A router does not know which
server mounts it, but its `request.principal` is whatever that mount
authenticated. Two annotations on an `x-telo-context` express this:

- `x-telo-context-from-referrer` types a node from the scope of each resource
  that references this one;
- `x-telo-context-nullable-when` says where a node may be null, based on a value
  the resource holds.

Both are read only by the analyzer. Each referrer is judged on its own, so a
finding that only some referrers cause names them.

## `x-telo-context-from-referrer: "<binding>[/<member>…]"`

This annotation goes on a binding of an `x-telo-context`, or on a member beneath
one reached through `properties`, at any depth. Its value is a path through the
referrer's scope: the binding, then each member, joined by `/`.

At each slot that references the resource, the analyzer resolves the scope in
force there and takes the node the path names. It resolves that scope at the
annotated site's own eval mode, so an accessor field reads the referrer's
accessor bindings and an evaluated field reads its evaluated ones. That node's
type **replaces** the annotated node's own keywords.

```yaml
# a field kind: `values` is the record of the form listing it
shown:
  type: object
  x-telo-context:
    type: object
    properties:
      values:
        x-telo-context-from-referrer: values
        x-telo-context-eval: accessor
  properties:
    at: { x-telo-eval: accessor }
```

```yaml
# a router: each route's `request.principal` is what its mounts authenticated
inputs:
  x-telo-context:
    type: object
    properties:
      request:
        x-telo-context-from: request/schema
        type: object
        properties:
          principal:
            x-telo-context-from-referrer: request/principal
            type: [object, "null"]
```

Only the annotated node is typed from the referrer. Its siblings keep their own
typing. When a parent's `x-telo-context-from` merges a property map, it never
overwrites a member that carries its own typing annotation.

**More than one referrer.** The site is judged once for each distinct type the
referrers give, and a finding is reported once. If only some referrers cause a
finding, the message names them (`(as App.Server/open references it)`). The
editor offers a member only when every referrer's type declares it. A chain is
followed: if the referrer types its own node from *its* referrers, the analyzer
continues through them.

**No referrer.** When nothing references the resource, or a referrer's scope
lacks the path at that mode, the node keeps the keywords it declares itself, and
declaring none leaves it untyped. Declare the type that is safe when the
referrer is unknown. For a value that may be missing, that is a nullable type, so
an Api nothing mounts yet still has every unguarded `request.principal.subject`
refused.

**Misuse.** Written outside a binding's subtree, or beside another
`x-telo-context-from*` on the same node, the annotation is
`CONTEXT_FROM_REFERRER_INVALID`. A value that is not a path is
`SCHEMA_VIOLATION`.

## `x-telo-context-nullable-when: { at, equals, absent }`

This annotation also goes on a binding or a member beneath one. It makes the node
nullable wherever the resource's own value at `at` is one of `equals`. With
`absent: true`, it also does so where nothing is at `at`. The null is added to
whatever type the node resolves to: its own keywords, a referrer's type, or any
other typing annotation.

- `at` is a Relative JSON Pointer anchored at the **context holder**, in the
  grammar `x-telo-context-element-from-item` uses: a number of levels to climb,
  then a JSON Pointer to descend. For a region declared on a field, the holder
  is the object holding that field. For a region declared on a list's items, it
  is the item itself, so `0/authentication/anonymous` names a member of the
  entry in both cases.
- The pointer is resolved one segment at a time. A schema `default:` fills a
  member only when the object holding it is present, the way validation fills
  defaults. If the mount has no `authentication:`, nothing is at the pointer and
  `absent` decides. If it has `authentication: {}`, `anonymous` reads as its
  default.
- A computed value (`!cel`) counts as a match, and so does a choice the analysis
  has not decided: in doubt, the node is nullable. Under `!if` / `!switch` the
  value is read in each configuration, so the node is nullable in every
  configuration that matches.
- `absent` is required. `equals` may be empty only when `absent: true`.

The server side of the router example declares the principal once, on its mount
entries. One region then covers both the mount's own CEL and the slot holding
the router:

```yaml
mounts:
  type: array
  items:
    type: object
    x-telo-context:
      type: object
      properties:
        request:
          type: object
          properties:
            principal:
              $ref: "telo://Self/Principal"
              x-telo-context-nullable-when: { at: "0/authentication/anonymous", equals: [allow], absent: true }
    properties:
      mount: { x-telo-ref: { kind: Self.Router, use: dependency } }
      authentication:
        type: object
        properties:
          anonymous: { type: string, enum: [allow, deny], default: deny }
```

A route adds its own override on top of the type its mounts give:

```yaml
principal:
  x-telo-context-from-referrer: request/principal
  type: [object, "null"]
  x-telo-context-nullable-when: { at: "0/authentication/anonymous", equals: [allow], absent: false }
```

`request.principal.subject` on a route is then refused (`CEL_NULLABLE_ACCESS`)
in these cases:

- some mount reaching the route has no `authentication:`;
- some mount reaching the route allows anonymous callers;
- the route itself says `authentication: { anonymous: allow }`;
- nothing mounts the router.

A `request.principal != null` guard proves the read, as with any nullable
value.

**Misuse.** A malformed value is `SCHEMA_VIOLATION`. The warning
`CONTEXT_NULLABLE_WHEN_INVALID` is reported at the kind, for the entry's own
modules, in these cases:

- the annotation sits outside a binding's subtree;
- the pointer climbs above the resource, or above a named shape, whose holder is
  not known;
- the pointer names a member the schema does not declare on its path;
- an `equals` literal is one the target's schema refuses.

## Runtime

Neither annotation exists at runtime. The kernel reads no context, and what the
transport puts into a binding is the controller's to supply. The static typing
is what keeps a manifest from reading a member that may be null.
