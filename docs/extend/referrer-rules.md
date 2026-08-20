# Referrer rules

[Resource rules](./resource-rules.md) relate the fields of one resource.
`x-telo-referrer-rules` relates a resource to **the one that references it**.

`Http.Reference` renders the OpenAPI document an `Http.Server` collects from its
routes. Mount it on a server that declares no `openapi:` block and there is
nothing to render — a disagreement neither kind can state on its own, and one
that otherwise surfaces at boot, after the port is bound.

## Writing a rule

The annotation goes inside the kind's `schema:` block, on the kind that **has**
the requirement:

```yaml
kind: Telo.Definition
metadata:
  name: Reference
capability: Telo.Mount
schema:
  type: object
  properties:
    title: { type: string }
  x-telo-referrer-rules:
    - referrer: Self.Server
      condition: !cel "has(referrer.openapi)"
      code: HTTP_REFERENCE_WITHOUT_OPENAPI
      message: >-
        mounts an Http.Reference, but declares no `openapi:` block, so no OpenAPI
        document is collected and the reference has nothing to render. Declare
        `openapi.info` on this server.
```

A server mounting that reference without an `openapi:` block now fails
`telo check`, reported on the **server**, at the mount slot that reaches the
reference:

```
app.yaml:35:5  error  Http.Server/server at 'mounts[1].mount': required by
Http.Reference — mounts an Http.Reference, but declares no `openapi:` block, …
REFERRER_RULE_VIOLATED
```

## Declared by the kind with the requirement

The requirement belongs to the kind that needs something, never to the kind that
must supply it. That is not a stylistic preference:

- **It scales.** A third-party mount can carry its own requirement without
  `Http.Server` knowing the kind exists. The alternative — a rule on the server
  listing every mount kind and what each one needs — has to be edited by someone
  else every time a kind is added.
- **It is sound.** Written on the referring side, the rule would have to name the
  mounted kind as a string, and a manifest spells a kind with the alias *its*
  author imported it under (`Http.Reference`, `Web.Reference`, …). A rule
  matching one spelling silently passes on every manifest using another. Written
  here, the subject is chosen by the reference itself, so no kind literal appears
  on that side at all.

## What is in scope

| Binding | Is |
| --- | --- |
| `self` | the resource the rule is declared for — the one being referenced |
| `referrer` | the resource that references it |

There is deliberately no `this`: in a resource rule `this` is an *element* of a
collection, and giving one word two meanings across the two families is how an
author learns a rule vocabulary twice.

## `referrer:` — which references the rule is about

The filter names the kind a referring resource must be, in the alias-qualified
grammar `extends:` and `x-telo-ref` use — `Self.Server` for a kind in this
library, `<Alias>.<Kind>` for an imported one, `Telo.<Kind>` for a built-in. It
is canonicalized in the declaring module's scope, so evaluation compares
canonical kinds and never sees an alias. A child of the named kind matches, as it
does at a ref slot.

Omitting it applies the rule to **every** resource that references this one,
which conflates "references me" with the relation the rule is actually about.
Write it.

A filter that resolves to no kind is `REFERRER_RULE_INVALID` at the kind that
wrote it: it matches nothing, so the rule would pass everywhere while checking
nothing.

## Polarity, restrictions, budget

Identical to resource rules, and for the same reasons: `condition` is TRUE when
the rule **holds**; a `hostBacked` or non-deterministic function is refused at
the kind; a rule that throws is a defect in the rule, not in the manifest it ran
against; and each rule gets 50 ms per resource. See
[Resource rules](./resource-rules.md#restrictions).

Guard optional fields — `has(referrer.openapi)`, `referrer.?tls.orValue(false)` —
because an unguarded missing key throws rather than yielding false.

## When a rule does not run

- **A value the condition reads holds a `!cel`.** The verdict would be about a
  placeholder, so the referrer is skipped and the skip is reported
  (`REFERRER_RULE_SKIPPED`). Only the nodes the condition actually reads count: a
  server carrying `port: !cel "ports.http"` does not disable a rule about its
  `openapi:` block.
- **Nothing matched.** If no resource of your kind was referenced by anything the
  filter matches, the rule never ran, and that is reported once
  (`REFERRER_RULE_UNEXERCISED`). This is what a typo in `referrer:` looks like
  from the outside — silence that reads exactly like passing.

## Diagnostics

| Code | Severity | Means |
| --- | --- | --- |
| `REFERRER_RULE_VIOLATED` | the rule's `severity` | a referrer broke the rule; reported on the **referrer**, `data.path` anchors the slot |
| `REFERRER_RULE_INVALID` | error | the rule itself is malformed, names an unresolvable `referrer:`, throws, or exceeded its budget |
| `REFERRER_RULE_SKIPPED` | information | the rule could not run for this referrer |
| `REFERRER_RULE_UNEXERCISED` | information | the rule never ran anywhere |

A violation names the declaring kind in the message (`required by
Http.Reference`). Unlike a resource rule, the resource carrying the diagnostic is
not of the kind that wrote the rule, so without it the trail back would depend on
the author remembering to write it into their prose.

## Ownership

A **violation** is a fact about the referrer's data, so it is reported only when
that manifest belongs to the workspace being checked — a dependency's manifest is
not yours to fix. A **defect in the rule** is anchored on the declaring
definition, and downgraded to a warning when that definition belongs to a
published dependency, since an error there would block `telo check` on a line you
cannot change.

## Keep the runtime guard

As with resource rules, the check moves a failure earlier without replacing the
controller's own. `Http.Reference` still raises at startup — before the port is
bound — when it finds no document to render.
