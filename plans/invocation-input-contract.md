# Invocation contract

## Problem

Telo declares "what does invoking this take, and what does it return" in inconsistent spellings and enforces it in some places and not others.

**Inputs.** `inputType:` on a `Telo.Definition` is the kind-level contract. Separately, the six `modules/run` kinds (`Sequence`, `Value`, `Choice`, `Iteration`, `Projection`, `Loop`) declare a per-instance JSON-Schema property map at `inputs:`, never read at dispatch — `grep resource.inputs modules/run/nodejs/src` returns nothing on all six. A declared `default:` never applies and no value is validated.

**Outputs.** Only `Run.Choice` can declare what it returns. The other five have a result-producing field (`outputs:`, `value:`) but no way to declare its shape, so `steps.X.result` falls to a permissive fallback and every field read off it is unchecked.

**Inheritance.** `inputTypeForKind` / `outputTypeForKind` do own-else-parent, one hop, and are documented as editor display helpers — so a two-level chain resolves to nothing, and nothing states whether a child's declaration replaces its ancestor's or extends it. And a `base:` child that declares `inputType:` / `inputs:` passes `telo check`, runs, exits 0, and does nothing at all: the mapping is never read, because such a child inherits the parent's controller and the kernel returns that instance verbatim, so nothing intercepts `invoke()`.

**Enforcement is an opt-in each controller re-decides.** `ctx.createTypeValidator()` validates one explicitly-passed type ref; `JS.Script` and `Starlark.Script` apply it to both directions, `Run.Choice` to outputs only. Three modules of roughly forty. **Defaults are filled nowhere at all.** Template-form definitions dispatch by calling `entry.instance.invoke(...)` directly, outside the kernel chokepoint entirely — and so does every consumer controller holding a resolved `!ref`. Phase-5 injection puts the live instance straight into the config object, so the AI model, MCP client, codec, credential and record-stream controllers all read it off `this.resource` and invoke it in hand; `REF_IDENTITY` exists precisely so such a consumer *can* dispatch through the traced chokepoint, and it is opt-in. A chokepoint-only guarantee would reach none of them.

So a caller that omits an input with a declared default gets a CEL `No such key` inside the callee, several steps from the cause; across an import boundary it names a manifest the author never wrote. A misspelled input, a wrong-typed value, a misread result field, and a whole declared mapping are all silent. The analyzer types `inputs.<name>` from a contract the runtime ignores.

Underneath is a naming collision: `inputs:` means *a schema* on a run kind and *values* at a call site.

## Solution

Establish one invariant — **`inputs`/`outputs` are always values; `inputType`/`outputType` are always schemas** — then enforce both contracts statically and at dispatch.

**One resolver, both directions.** A shared resolver answers "what is this target's input/output schema", layering the instance manifest's own declaration → the kind's `Telo.Definition` declaration → permissive, and resolving a `telo#Type` through `resolveTypeFieldToSchema`. It lives in `analyzer/nodejs/src` (browser-safe) and the kernel re-imports it — the split used for `buildEvalPaths`/`evalPathCovers` and the redaction path parser. `buildStepContextSchema` becomes a *caller* of it: today it is analyzer-only, caller-side, and needs `allManifests` plus a definition registry, while the kernel has only `createTypeValidator`, which compiles one explicitly-passed ref with no layering and no fallback. Leaving that split would have `telo check` validating against instance→definition→permissive while the runtime validated `resource.outputType` alone — the same drift this plan exists to close. The kernel resolves refs **in the declaring module's scope**, since a `telo#Type` reference goes through import aliases.

No annotation is needed to opt in: resource-doc validation admits only `kind`, `metadata`, and fields the kind declares in its own schema, so *declaring the property is the opt-in*. `JS.Script` already does this for both directions.

**Inheritance — resolve, never merge.** `inputType` / `outputType` resolve to the **nearest declaration** along the `extends` chain: a definition that declares one *fully replaces* its ancestor's, and one that declares none inherits its ancestor's verbatim, at any depth. `mergeTypeSchemas` does not apply — a call signature is not additive the way construction config is, and merging produces a union no caller can satisfy: the child's own required fields plus the parent's, when the point of declaring a signature is that the child accepts something *different*. `effectiveAuthorSchema` and `effectiveStatusSchema` keep merging and are untouched; contract resolution sits beside them in `extends-resolution.ts`, resolved in the scope that declared each definition and stamped at registration. This is also what fixes today's one-hop helpers, where a two-level chain resolves to nothing.

A replacement has to be bridged back to whatever actually executes, and how depends on where the controller comes from:

- **the child inherits a controller** (concrete `extends` + `base:`) — declaring `inputType` **requires** a paired `inputs:` mapping and declaring `outputType` requires a paired `result:` mapping. The mapping is the adapter: it turns the child's signature into the parent's call and the parent's result back into the child's. Declaring either without its mapping is a static error naming both contracts.
- **the child implements an abstract** (own controller) — there is nothing to map to, since the child's controller *is* the implementation. The declaration simply replaces, and the wiring rule below governs where the child may be used.

Replacement does not weaken substitutability, because `extends` never carried the dispatch contract to begin with — it says which slots accept the resource. What is checked is the **wiring**, per slot, by whether the caller can supply the target's arguments at all:

- the slot's declared kind declares no `inputType` (`Telo.Invocable`, `Telo.Runnable`, and most abstracts) → no contract to violate → accept;
- it declares one **and** the wiring site takes a paired author `inputs:` → the author supplies the arguments and knows what they referenced → accept, and check that map against the *target's* own resolved contract. Keyed on the slot admitting a paired `inputs:`, not on the author having written one, so a target whose inputs are all optional or defaulted stays callable with none;
- it declares one and the site takes **no** paired `inputs:` → the consumer's controller builds the arguments and knows only the slot's kind, so the wired resource must honour that contract, else a static error naming both.

Four abstracts fall in the third case today — `Codec.Encoder`, `Codec.Decoder`, `Http.Credential`, `Mcp.Client` — and the `invoke`/`inputs` pairing is already in the field map via `x-telo-topology-role`, so the rule names no kind. A dispatch the analyzer cannot see (a scope-local ref, a late-resolved target) fails at runtime with the same message.

**Remapping an inherited contract.** With the mapping declared, a `base:` child works: at dispatch the child's own contract is validated, `inputs:` is applied over `self` + `inputs` to build the parent's arguments, those are validated against the *parent's* contract, the inherited controller runs, and `result:` maps its output back, validated against the child's `outputType`. The kernel still returns the parent instance verbatim from `create()` — the mapping is part of what it binds to that instance (below), so nothing wraps it and `init`, `snapshot`, `teardown` and status plumbing are untouched. Without a declared contract, `base:` behaves exactly as today.

**Migration.** The six run kinds drop `inputs:` and declare `inputType:`; the five lacking it gain `outputType:`. Each result slot — `Sequence.outputs`, `Value.value`, `Projection.outputs`, `Loop.outputs` — is annotated `x-telo-value-schema-from: outputType`, as `Choice`'s rows already are, so the existing generic check validates the produced value with no new analyzer code. An **instance** that declares `outputType` must declare its result slot; the requirement is per instance, not per kind, because `Sequence`, `Iteration` and `Loop` are `Telo.Runnable`s that implement both verbs — the same kind serves a boot target (declares neither, returns nothing) and an invoked step (declares both). 68 input declarations across 39 source files migrate in one change.

**Typing `inputs.<name>` inside a body** is not a re-point of the existing annotation. `x-telo-context-from` merges the navigated value as a property map and `x-telo-context-from-root` substitutes it verbatim; neither resolves a `telo#Type`, so the inline `{kind: Type.JsonSchema, schema: …}` form the standard library uses everywhere would type `inputs` as `{kind, schema}`. The context-annotation path gains type-field resolution through the same shared resolver.

**Static half**, in the analyzer: call-site `inputs:` values validated against the target's resolved contract, after `substituteCelFields` replaces CEL leaves with schema-shaped placeholders so expressions never false-positive; a template's `inputs:` mapping validated against the *dispatch target's* contract and `result:` against its own `outputType`; a controller-inheriting child that declares `inputType` / `outputType` without its paired mapping; the ref-slot wiring rule above, erroring only where the consumer builds the arguments and the wired resource's contract differs; a warning for a declared input neither `required:` nor defaulted; a dedicated diagnostic for a leftover `inputs:` on a migrated kind.

The `run()` guard keys on the **dispatch site's verb and the instance's resolved contract**, never on the kind or its capability — `Sequence`, `Iteration` and `Loop` are declared `Telo.Runnable` while implementing `invoke()` as their primary verb, so capability does not name the verb a given site uses. A resource whose resolved contract declares inputs is an error at a run site: a bare or gated `targets:` entry, and a `Run.Sequence` scope target. An inline `{ invoke, inputs }` target step is an **invoke** site and is checked like any other call site.

**Runtime half — the contract is bound to the instance at creation.** A contract is only a guarantee if it cannot be dispatched around, and a resolved `!ref` reaches most consumer controllers as a live instance they invoke directly: `Ai.Agent` reads `this.resource.model` — injected by Phase 5, never resolved through the context — and calls `model.invoke(...)`. Enforcing at a handoff would therefore mean enforcing at *every* handoff — Phase-5 injection, `ctx.resolveRef`, scope-handle resolution, the template controller's direct dispatch, `ctx.invoke`'s target lookup — and one forgotten site silently reopens the hole.

So the kernel binds instead. `controller.create()` is called from a single place, and both contracts and any `base:` mapping are fully resolved there, so the kernel binds a **contract-enforcing dispatch entry point onto the instance as it is produced**: it fills declared defaults, validates inputs, applies the mapping, dispatches through the chokepoint (traced like every other dispatch), and validates the result. One production site, by construction — every consumer, on every path, holds an instance whose dispatch already enforces, and `base:` remapping needs no second mechanism.

`provide()` is bound the same way. It takes no caller arguments, so it has no input side, but it returns a value against a declared `outputType` and that result is validated exactly as an invocable's is — same code path, same stream skip, same error code. `run()` is bound to nothing: parameterless and void, it is guarded statically instead.

Binding rather than wrapping is what makes the rest a non-problem. There is one object, so every controller-specific member — `conn.transaction()`, `Cache.Store`'s methods — is genuinely its own, with no forwarding contract to specify and nothing that breaks when a controller adds a method. Prototype identity is untouched, so `instanceof` across the SDK realm boundary still holds. And `stripCompiledValues` / `detachSnapshotValue` see exactly the object they always saw. The mechanism is the one `stampRefIdentity` already uses — a non-enumerable own property on the live instance — moved from injection to creation and made non-optional rather than something a consumer may opt into. `REF_IDENTITY` moves with it: kind and name are known at `create()` too, so stamping happens once at the same point and the idempotent re-stamp on every injection goes away.

The one real consequence is that the kernel's `invoke` shadows the controller's, so a controller calling `this.invoke()` internally now goes through its own contract. That is the correct behaviour and is stated normatively, not left to be discovered.

Around it, a consolidation rather than a new capability: the binding and `runInvoke` share one code path. The `run()` path does none of it. The template controller's three direct `entry.instance.<verb>()` calls route through `invokeResolved` / `runResolved`. `JS.Script`, `Starlark.Script` and `Run.Choice` drop their controller-side validators.

**Normative spec.** `useDefaults` is a non-standard AJV extension with implementation-defined behaviour under `anyOf`/nesting, so prose plus one implementation would leave a second-language kernel guessing. A new `kernel/specs/invocation-contract.md` (joining `logging.md` and `module-artifact.md`) fixes: default-fill semantics and traversal order, error codes and payload shape, their status against `throws:` unions, contract resolution along `extends` and the mapping requirement, the binding rule with the verbs it covers and its shadowing consequence, ordering relative to the dispatch span, the stream-skip rule in both directions, and how far the defaults copy reaches. What is normative is that **the kernel binds a resource's resolved contract to its dispatch entry point at creation, so an instance is never observable in an unbound form** — not any particular Node mechanism. Another kernel expresses that however its runtime allows; no proxy semantics leak into the spec.

**Obligations.** Changesets for `@telorun/analyzer`, `@telorun/kernel`, `@telorun/sdk`, `@telorun/run`, `@telorun/javascript`, `@telorun/starlark`; `modules/run` docs (six files plus README), `Run.Choice`'s `throws:` block, `docs/extend/kind-inheritance.md`, `CLAUDE.md` (the `extends` / `base:` and lifecycle sections), and the authoring-agent system prompt must be updated in the same change.

## Decisions

- **Key on field names; no new `x-telo-*` annotation.** Declaring the property in the kind's schema is already the opt-in, and `outputType` already works this way.
- **Hard removal of `inputs:`, standard library migrated in one go.** Rejected keeping it as sugar: one concept with two spellings forever costs more than a bounded migration, and the visual editor would render both. Safe for the ecosystem because a published module pins its `Run` import by digest.
- **`outputs:` is not migrated.** It is the value producer — a return statement, not a type — so it coexists with `outputType:`. Only `inputs:` was overloaded.
- **`inputType` / `outputType` replace along `extends`; they never merge.** A declaration resolves to the nearest one in the chain. Merge was rejected because a call signature is not additive: folding the child's required fields with the parent's yields a union no caller can satisfy, and it rejects the very remapping this feature exists for — the child's whole point is accepting something different. Substitutability is a *wiring* question, answered by the wiring rule, not by forcing a child to keep accepting its parent's arguments. Resolution still replaces today's one-hop own-else-parent helpers, so multi-level chains stop resolving to nothing.
- **A replacement on a controller-inheriting child must be mapped.** Declaring `inputType` without `inputs:` (or `outputType` without `result:`) is a static error: the inherited controller only understands the parent's shape, so an unmapped replacement is a signature the executing code cannot honour — exactly today's silent no-op, made loud. A child of an abstract has its own controller and nothing to map to, so it is exempt.
- **`base:` + an invocation contract is allowed, and keeps full substitutability.** This reverses an earlier draft that made the combination an error, and a second one that removed such a child from its parent's ref slots. Both treated a *wiring* constraint (`x-telo-ref`, which resources may sit in a slot) as if it carried a *dispatch* contract (`inputType`, what a call sends). They are orthogonal except where a consumer's controller builds the arguments itself, so the check belongs at the wiring, keyed on whether the caller can supply them — not on what `extends` means.
- **The contract is bound to the instance at creation — not wrapped, and not enforced per handoff.** An earlier draft wrapped only `base:` children with mappings, which left the real hole open: a dozen standard-library controllers invoke a resolved `!ref` directly and never reach the chokepoint, so defaults and validation would silently not apply to precisely the four abstracts the wiring rule protects. A second draft enforced in `ctx.resolveRef`, which misses the *dominant* path — Phase-5 injection puts the raw instance in the config object, and `Ai.Agent` reads it straight off `this.resource`. Enforcing at handoffs means enumerating five of them and reopening the hole on the sixth. Binding at `create()` has one production site by construction, and since there is one object rather than a wrapper, member forwarding, prototype identity and the runtime-value walks all stay non-problems instead of becoming requirements. It is also the version another language's kernel can implement without proxy semantics: *a resource instance is never observable in an unbound form.*
- **`invoke` and `provide` are bound; `run()` is guarded statically.** `provide()` is parameterless, so it has no input side, but it returns a value against a declared `outputType` — `Mcp.Client` and `OAuth.TokenSource` declare one today — and that output is validated exactly as an invocable's result is, by the same binding, with the same stream skip and the same ambient error code. Leaving providers out would keep one whole capability in the opt-in state this plan exists to end. `Runnable.run(ctx?)` is different in kind: parameterless *and* returning void, so there is nothing to fill defaults into and no result to validate. Rejected extending the capability to `run(inputs, ctx)` — a spec change for every Runnable in every language, carrying a parameter no `targets:` entry can supply — and rejected smuggling values through `InvokeContext`, which would make defaults an opt-in controller property rather than a kernel guarantee. Instead a resource whose *resolved* contract declares inputs is an error at a run site. Keyed per instance on the site's verb, never on the kind or capability: `Sequence`, `Iteration` and `Loop` are `Telo.Runnable`s whose primary verb is `invoke`, so a kind-level or capability-level guard would reject every sequence used as a step.
- **Standard JSON Schema `required:`, not "required = no `default` key".** `inputType` is a real `telo#Type` that AJV validates; two meanings for one keyword is worse than one inconsistency with library `variables:`/`secrets:` and Application env.
- **The optional-and-defaultless rule is a declaration-site warning, not a flow analysis.** An earlier draft called it an extension of the null-safety pass; that pass models *nullability* and recognises only `== null` / `!= null` through `?:` and `&&`/`||`. Absence is a different property with a different guard vocabulary (`has()`, `.?`, `orValue`), none of which it knows — grafting them would give false positives on `!= null`-guarded reads and false negatives on `has()`-guarded ones. A declaration-site check is total and reproducible by another language's checker. It is a **warning** because optional-and-defaultless is legitimate for a genuine tri-state input.
- **Contract errors form an ambient kernel union: catchable, typo-checked, excluded from coverage counting.** A `catches:` entry may name one and its `when:` is validated against the ambient set; the completeness rule keeps counting only the kind's own codes. Rejected folding them into every union, which would make every bounded `catches:` block in the standard library incomplete overnight, and rejected making them uncatchable. `Run.Choice`'s `ERR_OUTPUT_INVALID` is deleted rather than propagated — the ambient code replaces it and is still catchable.
- **Validation moves out of the three controllers that do it today**, both directions — otherwise it double-validates and controller wording pre-empts the kernel's.
- **Validation skips `x-telo-stream`-marked properties in both directions.** Streams travel on inputs as much as on results — `Codec.Encoder` marks `input` and lists it in `required`, and `Record.Stream`, `Ai`, `Tar` and `Console` do the same — so an input-only or output-only skip would walk a live `Stream` with AJV on the hottest path in the runtime. That is the same defect as `stripCompiledValues` walking a live instance in a ref slot, and the annotation already marks exactly the properties to leave alone.
- **Defaults and input validation are one pass**, over a copy that is deep along every path a default can reach and shared elsewhere. A flat shallow copy would not do: `useDefaults` writes at every level it encounters a default, so a nested default would mutate the structure the caller still holds. The default-bearing paths are known from the compiled schema, so the copy is bounded by them rather than by the size of the payload.
- **Unknown key, missing required and type mismatch are errors from day one**; `additionalProperties: false` is never implied.
- **`Run.Iteration`'s `outputType` is checked at dispatch only.** Its result is the collected per-item step results, with no single authored slot to annotate; deriving that shape from `x-telo-step-context` is a separate capability.

## Constraints from defects already fixed

Three bugs found tracing one failing application, all shipped. Listed as constraints on this implementation — each is the same class this plan addresses, and the new code sits in the same paths.

- **Live instances occupy declared slots.** `stripCompiledValues` walked a live `ResourceInstance` in a ref slot — which a template puts there by design when forwarding `self.<ref>` to a child — and a cyclic client graph overflowed the stack, reported as a schema violation on an innocent manifest. Any new AJV walk over runtime values must assume live objects appear in declared slots; hence the stream skip, and hence input validation must not descend into ref-typed properties. This is also the constraint that rules out injecting a wrapper in place of the instance: a second object in those slots would have to be taught to every such walk, whereas binding leaves the walks looking at what they always looked at.
- **Handles must hang off the owning context.** Phase-5 injection built every `with:` scope handle on the root context, so a library's scoped kinds resolved against the *application's* aliases. Contract refs resolved at create time must resolve in the declaring module's scope.
- **Failures must name their cause.** The init loop reported every failed resource flat, cascade first. Contract violations must name the target, the field, and which side supplied the bad value.

## Example: remapping an inherited contract

Today this passes `telo check`, runs, exits 0, and prints an empty line — the `inputType` and the whole `inputs:` mapping are silently inert:

```yaml
kind: Telo.Definition
metadata: { name: Shout }
extends: Console.WriteLine
schema:
  type: object
  properties:
    tag: { type: string }
base: {}
inputType:
  kind: Type.JsonSchema
  schema:
    type: object
    required: [msg]
    properties:
      msg: { type: string }
inputs:
  output: !cel "'[' + self.tag + '] ' + inputs.msg"
```

After the plan the same manifest works. `Shout` reuses `Console.WriteLine`'s controller and construction, and its `inputType` **replaces** the parent's rather than folding with it — `{ msg }` is the whole signature, and the `inputs:` mapping is what makes that legal, turning each call into the parent's `{ output }`:

```yaml
kind: Shout.Shout
metadata: { name: Loud }
tag: warn
---
kind: Run.Sequence
metadata: { name: Main }
steps:
  - name: s
    invoke: !ref Loud
    inputs:
      msg: hello        # → prints "[warn] hello"
```

Four boundaries are checked where zero are today: `{ msg: "hello" }` against `Shout`'s `inputType` at the call site and again at dispatch, and the mapped `{ output: "[warn] hello" }` against `Console.WriteLine`'s own contract — so a mapping that builds the wrong shape is caught where the mapping is written, not swallowed. Omitting `msg`, or passing `message`, is a `telo check` error.

`Shout` stays wired wherever `Console.WriteLine` is, because `extends` still decides that. What the wiring rule decides is per slot: at a site that takes a paired author `inputs:` — a `Run.Sequence` step, an inline target step — `Shout` is accepted and the author's map is checked against `{ msg }`. At a site where the consumer's controller builds the arguments itself and knows only `Console.WriteLine`, `Shout` is rejected, naming both contracts, because that controller would send `{ output }` to something that accepts `{ msg }`. Dropping the `inputs:` mapping is its own error — an unmapped `{ msg }` signature over a controller that reads `output` is the silent no-op this plan exists to end.
