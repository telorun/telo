---
"@telorun/cel": minor
---

`@telorun/cel`'s schema conversion stops typing anything `dyn` in silence.

A schema node that was a `$ref`, or that composed with `allOf`, was unjudged: the reader handled
`type`, `properties`, `items`, `anyOf` and `oneOf` and **fell through to `dyn`** for everything else. A
variable typed through a reference therefore kept exactly the behaviour deep typing exists to end — a
typo two levels in survived. The finding was never "`$ref` is unimplemented"; it was "an unread keyword
silently becomes `dyn`", so the rule is now that **nothing a schema says may fall through silently**, and
the four parts below are what implements it.

**References split at the document boundary.** The conversion's input is a node **plus the document it
belongs to** (`{ schema, document? }` on a registration), the document travelling with the node as the
descent moves between documents. A document-local reference (`#/$defs/…`, `#/definitions/…`) is resolved
by the engine against the document in hand. A reference that **leaves** the document is answered by the
one host resolver the engine already consults at every node, whose answer widens from "a registered type
name with arguments" to "that, **or the document to read in place of this node**"; the resolver is handed
the node and its document, because which document a reference outside this one resolves against — and how
a relative one is rebased — is the host's own rule. No second seam, and no copy of the host's registry
inside the engine.

**`allOf` intersects**, and so does everything else one node says about its own type: records merge
field-wise and a narrower scalar wins, so a reference beside a `properties` block, or two partial
records, compose — a field of each half reads and a third is `CEL_UNKNOWN_FIELD`. **`enum` and `const`
with no `type` are read from their values' JSON types**, which is what makes a constant beside a
host-typed branch a `string` rather than a `dyn` that collapses the whole union.

**The conversion reports every node it could not judge**, each by JSON Pointer beside the type it
produced (`schemaReports()` on an environment), with one reason from a closed set: `keyword-not-read`,
`shape-not-read` (a tuple `items`, a `type` naming no JSON type), `reference-unresolved`,
`intersection-empty`, and `named-type-unregistered` — the host's resolver naming a type nothing is
registered under, the host disagreeing with itself, which the structural reading used to paper over
silently. It **reports rather than refuses** because such a node is usually a third party's
data — a schema shipped inside something a host merely loaded — so throwing at registration would turn
someone else's schema into a crash, while typing it `dyn` quietly is the hole itself. A node beyond the
conversion's own document carries the pointer of the reference that led out of it, so a consumer anchors
at a line it has.

Completeness rests on an **engine-owned closed list of the keywords that can change what CEL type a node
has**: one the reader does not read is reported, and a node carrying none of them says nothing about its
type and is `dyn` legitimately. A keyword that constrains a *value* rather than its type (`required`,
`contains`, `propertyNames`, `format`, every bound) is deliberately off the list. The list and the reader
are held to each other in both directions, with the mechanism's own blind spot written down beside it.

A reference **re-entered** on the descent — a recursive schema — is the one deliberate `dyn`, declared as
such rather than reported: the descent terminates and the outer reading is what the consumer gets. A
shape referenced a hundred times still converts once, and the cost bound is measured on a fixture whose
every level is reached through a reference and merged out of two `allOf` halves.

Still nothing consumes the package: `@marcbachmann/cel-js` serves the whole repository, and no manifest,
consumer or module changes.
