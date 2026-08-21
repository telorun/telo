---
"@telorun/analyzer": minor
"@telorun/ide-support": minor
---

Make the CEL scope a QUERY, and give CEL expressions completion, hover and
go-to-declaration on top of it.

What an expression is typed against — the CEL environment plus the resolved
`x-telo-context` schema — used to be assembled inline inside the analysis pass,
built for one `engine.analyze` call and discarded. Nothing outside that loop
could obtain it, so an IDE wanting to say what a cursor sees had only two
options: re-implement the rule, or read a map keyed by paths the last analysis
happened to visit. The first drifts silently the day the scope gains a name
(`x-telo-bindings-from` did, value-type parameters did), because no test can
hold two implementations of an open rule in agreement; the second cannot answer
mid-token, which is exactly when the question is asked.

`CelScopeResolver` (`cel-scope.ts`) is now the one answer, and the pass is one of
its callers. `CelScopeQuery` (reached through `AnalysisRegistry.analysisOf(manifests)`) is the
way in from outside: it resolves for an ADDRESS — a manifest and a concrete path,
indices and all — recomputing the `x-telo-context` match exactly as the manifest
visitor does, so a site the last analysis never walked still types. A completion
list is therefore a claim that what it offers will pass `telo check`, rather than
a second model of what CEL sees.

On that: `buildCompletions` now completes inside a `${{ }}` / `!cel` body — the
scope's root names and a context property's members, plus the global functions
the environment declares — and offers nothing where the scope declares no shape,
rather than guessing. `buildHover` gained a CEL branch it never had, reporting an
identifier's type and description. `buildDefinition` gained `steps.<name>`
navigation, the one CEL scope whose members are written in the manifest but
reached through no reference slot; it is found through the declaring kind's own
step-body annotation and the shared nesting walk, so a step inside a branch
resolves and no resource kind is named.

It also navigates CEL CONTEXT BINDINGS — `request.query` to the route's own
`request.schema.query`, `self.<field>` to the definition's `schema`,
`result.<field>` to the INVOKED resource's `outputType`. These are the same
category one level out: a binding exists because an `x-telo-context-*`
annotation derived it, so the site is found by re-walking that annotation, and
one walk covers every transport and every kind that declares one. `scopeAt`
resolves the annotation into a schema and loses the provenance, so the
declaration side is its own method (`contextDeclarationSite`) rather than an
origin field on `CelScope` that every type consumer would ignore. Each candidate
path is checked against the manifest before it is returned, so a binding the
author never declared — an annotation's static fallback properties — resolves to
nothing rather than to a guessed node or to a dependency's schema.

`telo check` validates a call made through a REFERENCE SLOT, not only one made
from a step. The step driver found its argument map through the step grammar
plus a sibling `x-telo-topology-role: inputs`, so an HTTP route's `handler:` +
`inputs:` pair — which is neither — went unchecked: a misspelled key or a missing
required input surfaced at dispatch inside the callee. Discovery is now driven by
the same `x-telo-ref` `inputs:` pointer the editor reads, with the step case as
one caller of one check, so every kind that names its argument slot is checked
without the analyzer learning about routes or steps.

Completion offers the keys an invoked target declares. A slot that transfers
control names its argument slot on its own `x-telo-ref` (`inputs: /inputs`, a
pointer relative to the enclosing object) — the only thing tying an `inputs:` map
to the resource it holds arguments FOR, since the map is an open object and the
reference sits in a sibling whose name no walker may assume. Reading that pointer
means the keys offered are the ones the shared contract resolver produces, so
they are what `telo check` validates the call against and what the kernel binds
at dispatch, instance declaration winning over the kind's.

The queries that need BOTH this registry and a manifest set now hang off one
object, `ManifestAnalysis` (`AnalysisRegistry.analysisOf(manifests)`), replacing
`celScopeQuery`. Four such questions arrived in short order — CEL scope, step
declarations, context-binding declarations, invocation contracts — and each was
otherwise another factory on the registry and another optional parameter on every
IDE entry point. Naming the pairing once stops that accretion; each facet keeps
its own honest name rather than piling onto whichever one existed first. Nothing
re-implements an answer: `contractFor` IS the shared `resolveContract`, given the
scope to run in. `analyzerContractScope` moved beside that resolver, where it
belongs, rather than living in the CEL scope module.

Completion offers the values a schema says a slot may take, in the two positions
where a schema says so, and the open/closed distinction is the KEYWORD rather
than a flag: `enum` constrains, `examples` only suggests. For a NAME-KEYED map —
an HTTP `content:` block, whose keys are media types the author chooses —
`propertyNames` is JSON Schema's own vocabulary for what a key may be, so
`propertyNames: { examples: [...] }` is an open list of known keys with no
validation footprint. For an ordinary field, `enum` / `examples` on the field
itself. Both are stock JSON Schema, so nothing in the analyzer learns what a
media type is and any name-keyed field gains the behaviour by declaring one.
Value-slot completion did not exist at all before this — a field with a declared
`enum` offered nothing, though hover already reported the allowed set.

Completion and hover now follow `x-telo-schema-from`. A slot annotated with it
declares no `properties` of its own — an `Http.Api` route's `request:` is exactly
this, deriving its shape from `HttpDispatch.Request/$defs/Matcher` — so the
schema walk landed on an empty node and offered nothing at all under it. Silent,
and it made a whole field of the standard library behave like an unknown one.
`AnalysisRegistry.resolveSchemaFrom` resolves the annotation in the DECLARING
kind's module scope (anchors are alias-qualified), sharing one rule with the
field-map expansion that already resolved it for Phase-5 injection; only the
static dotted-anchor form resolves, since a relative anchor names a sibling
property whose value is known per resource.

Function candidates are one per FUNCTION, not one per overload. The CEL registry
declares a signature per accepted argument list — `double` has four — so mapping
each to its own item produced four identical labels an author cannot choose
between; the overloads are now folded into one entry, counted on its detail line
and listed in its documentation. A CEL type name is separately registered both as
a variable of type `type` and as the conversion function of the same name, which
is a second way one label arrived twice: the callable form wins the slot and its
documentation records the other reading.

`buildSemanticTokens` now colours the inside of a CEL body, which under a stock
YAML grammar is painted as the string it is not. Doing it in the semantic layer
rather than in a grammar is what makes one implementation serve both hosts — they
already share this function, while a Monarch tokenizer beside the VS Code
TextMate one would be a second CEL lexer to keep in agreement. It is also the
only layer that can be right about names: a grammar knows the roots someone
hardcoded into it (which is why `request` and `steps` went uncoloured), while the
scope query knows what is in scope at that exact site. So a name the scope
confirms is coloured and one it cannot is left alone — the quiet signal an
unresolved `kind:` already gives. With no query, names are coloured
syntactically instead, so a CEL body never reads as a plain string.

The ROOT of a chain is a `namespace` and its members are uniformly `property`,
so `request.params.turnId` reads as scope · path rather than one undifferentiated
run. Colour encodes what a symbol IS — the invariant every language holds to —
and a CEL root is not data the author declared, it is a scope the runtime
injects. Colouring by the SHAPE of the value behind a name (object vs scalar) was
considered and rejected: it is type-directed highlighting, so the palette becomes
a type legend, a name changes colour as analysis resolves, and it says nothing
exactly where the scope declares no shape.

`SemanticTokenType` gains `property`, `function`, `number`, `string`, `keyword`,
`operator` and `namespace`, appended to `SEMANTIC_TOKEN_LEGEND` — never inserted,
since a host registers the legend once at activation and an insert would repaint
every existing token as something else. All seven are stock LSP names, so themes
colour them with no extra configuration.

Each of these takes an optional `CelScopeQuery`; without one, CEL support is
silent (or, for colouring, syntactic) and every existing behaviour is unchanged. Structural traversal (`resolveLocalRef`,
`gatherPropertySchemas`, `walkStepArray`) moved to `schema-walk.ts` so the scope
rule and the analysis pass can both reach it without either importing the other;
all three are re-exported from `analyzer.js` unchanged.
