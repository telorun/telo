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
| `entry` | *(with `peers:`)* the referrer's own entry that reached me |
| `peers` | *(with `peers:`)* that collection's other entries |

There is deliberately no `this`: in a resource rule `this` is an *element* of a
collection, and giving one word two meanings across the two families is how an
author learns a rule vocabulary twice.

## `peers:` — the declarations listed beside me

A rename marker is wrong only in relation to the *other* tables a schema
declares. An enum a column names is unlisted only in relation to the same set. A
resource rule sees one resource and a plain referrer rule sees a pair; neither can
state a relation between **siblings**.

`peers:` is a JSON Pointer naming a collection **of the referrer** to resolve:

```yaml
x-telo-referrer-rules:
  - referrer: Self.Schema
    peers: /tables
    condition: !cel "!has(self.renamedFrom) || !peers.exists(p, p.table == self.renamedFrom)"
    code: SQL_RENAME_SOURCE_STILL_DECLARED
    message: >-
      renames from a table this schema also declares. A rename's source is the
      table being retired, so declaring both would rename one live table onto
      another and retire neither.
```

`peers` binds the whole collection rather than one member at a time, which is what
lets a condition be an existential over the set (`peers.exists(…)`,
`peers.all(…)`).

### Entries bind as written, references resolved one level

A collection's items are not always references — a server's `mounts:` holds
`{mount, prefix}` — so each entry binds **as written**, with the references
*inside it* resolved: `p` is the declaration where the entry is a bare `!ref`, and
`p.mount` is the declaration with `p.prefix` beside it where it is not. Nothing is
guessed from the item schema, and there is no second pointer to write.

One level only. References inside a resolved declaration stay references, because
a self-referencing foreign key and a mutual pair are both cycles.

### One evaluation per entry

A rule declaring `peers:` evaluates **once per entry**, anchored at that entry's
slot path — a deliberate departure from the judge-once rule the family otherwise
follows. A rule reading `entry` is about the entry, so a resource listed twice has
two entries to answer for.

`self` is excluded from `peers` **by slot path**, not by identity: exact, cheap,
and correct when the same resource is listed twice. A `peers:` naming a collection
*other* than the one that reached me excludes nothing, because nothing there is
me — which is exactly what a rule over a schema's `enums:` wants while its own
entry sits in `tables:`.

### What is refused, and where

`peers:` must name a collection the `referrer:` kind declares whose items are, or
contain, a reference — a collection of plain data resolves nothing, so the rule
would silently never see a declaration. It also requires `referrer:`: without a
kind there is nothing to check the pointer against. Both are
`REFERRER_RULE_INVALID` at the kind that wrote the rule.

The check is Liskov in both directions. The filter is usually an abstract (one
rule serving every backend) while the collection is declared by the backends that
implement it, so a pointer resolving on any candidate resolves the rule.

### `peers:` needs a `requires:` floor at first adoption

The rule reader is lenient, so an analyzer released before `peers:` existed reads
the rule, ignores the unknown key, and evaluates the condition with `peers` and
`entry` unbound — cel-js throws, and the throw is reported as a rule defect
anchored on the module's own line, blaming an author who cannot act on it.

The first module to write `peers:` must therefore declare
`requires: telo: ">=<the release that carries it>"`, verified by execution:
strip the block, run the previous published CLI against the manifest, confirm it
rejects; restore it and confirm the same runtime reports
`MODULE_REQUIRES_NEWER_RUNTIME` instead. See
[Declaring runtime requirements](./declaring-runtime-requirements.md).

**Peers-by-kind was rejected, not deferred.** A binding over "every resource of
this kind in the analysis" needs no resolution and is unsound: a physical name is
scoped by its namespace, so two schema resources over one connection — which the
schema design supports deliberately — would report a conflict between objects that
never meet. The reference collection is what defines the scope.

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

Write `condition:` with the `!cel` tag. The reader is lenient and a bare string
still runs, but untagged the expression is not CEL to the editor's colouring,
completion or hover — so the strict half reports it while the rule keeps working.

## When a rule does not run

- **A value the condition reads holds a `!cel`, or an `!include-*` embed.** The
  verdict would be about a placeholder, so the referrer is skipped and the skip
  is reported (`REFERRER_RULE_SKIPPED`), naming the tag it found. Only the nodes
  the condition actually reads count: a server carrying
  `port: !cel "ports.http"` does not disable a rule about its `openapi:` block.

  **A `!ref` is not one of them.** It names a declaration — a value a rule
  compares perfectly well, and the one peer rules are built on — so a slot
  holding a reference never skips a rule.
- **Nothing matched.** If no resource of your kind was referenced by anything the
  filter matches, the rule never ran, and that is reported once
  (`REFERRER_RULE_UNEXERCISED`). This is what a typo in `referrer:` looks like
  from the outside — silence that reads exactly like passing.
- **A peer resolved to nothing, or the collection is absent.** A reference in the
  `peers:` collection naming a declaration the analysis does not hold would bind a
  peer to nothing, so the entry is skipped and the skip is reported
  (`REFERRER_RULE_SKIPPED`).
- **Every peer set was empty.** A peer rule that only ever ran against an empty
  set proved nothing, and reports as `REFERRER_RULE_UNEXERCISED` — which is what a
  typo in `peers:` looks like from the outside.

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
