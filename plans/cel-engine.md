# A Telo-owned CEL engine

## Problem

CEL is Telo's only expression language — every `!cel`, every `!interpolate` and `!sql` hole, every
resource and referrer rule, every module function body — and Telo does not own it. The third-party
engine is a pinned runtime dependency of the SDK (it *is* the value domain's identity), of
templating, and of the analyzer. Four things follow, each one a thing Telo currently cannot do.

**The standard library cannot be changed.** Registering `duration(string): Telo.Duration` is refused
as an overlapping overload; there is no unregister, no override flag, and no option that omits the
standard library. So `duration("30d")` throws permanently, while `30d` is the spelling the standard
library ships and documents — and a duration value type has nowhere to go.

**Object types are shallow and nominal types are faked.** A variable typed from a schema becomes a
flat field map, so a nested typo survives a rule check and surfaces as `RESOURCE_RULE_UNEXERCISED` —
a coverage warning standing in for the error nobody can produce. `x-telo-type` arguments are erased
at the CEL boundary because types are identified by constructor identity, so a byte stream and a
string stream are one type. `Telo.TcpPort`, `Telo.UdpPort` and `Telo.Bytes` are field-less generated
wrapper classes with no operators of their own.

**Diagnostics are reconstructed from outside the engine.** One sentence is reported for unrelated
mistakes, so a separate classifier explains a rejection by re-deriving it from the registry *after*
the checker has already failed. It may only ever explain, never decide: a construct the parser
expands and the registry never sees must not become a hard error on valid CEL. `CEL_UNKNOWN_FUNCTION`
and `CEL_WRONG_CALL_FORM` are therefore lookups bolted beside a checker that already knew.

**Every expression is tree-walked on every evaluation**, and template bodies re-expand on every
dispatch. Nothing crosses runtimes: the Rust kernel has no CEL at all, which is why it hosts
`Telo.Invocable` only.

## Solution

A new top-level `cel` package — `cel/nodejs`, published as `@telorun/cel` — owning the parser, the
type checker, the standard library and evaluation, with `cel/rust` as its one-for-one mirror when the
Rust kernel takes CEL on. Templating, the analyzer, the SDK, `ide-support` and the kernel consume it;
the third-party engine leaves the tree. `@telorun/cel` joins the telo version line, because CEL
semantics decide the analyzer's verdicts and the kernel's behaviour, and its Rust twin carries the
same version.

**Semantics live once, in a runtime support library.** Every operator, conversion, macro and standard
function is implemented there — int64 as BigInt, unsigned and double distinct, RE2 regex, timestamp
and duration arithmetic, and CEL error *values* that participate in short-circuit rather than
exceptions that escape it. Two backends sit over it and neither re-implements any of it:

- an **emitter**, producing one JS module per manifest, content-hashed and cached under `.telo/cel/`,
  loaded by import — the same shape as the AJV standalone validators already cached under
  `.telo/validators/`;
- a **closure backend**, building callables with no `eval` and no disk, for the analyzer, the editor
  and anything running in a browser.

The emitted module is a derived cache and never a layer in a published artifact: an artifact layer
would freeze a module's CEL semantics to one emitter version, and publishing for a Rust kernel would
then need a Rust emitter at publish time. Portability comes from porting the package.

**No privileged builtins.** The standard library registers through exactly the mechanism available to
anything else — per environment, last-wins by exact signature, with explicit removal. That is the
only shape under which a module can replace `duration(string)`, and it is what unblocks a duration
value type. *Verify:* an environment that replaces `duration` resolves the replacement and the
original is gone from `telo cel functions`; one that removes a standard function reports
`CEL_UNKNOWN_FUNCTION` at a call site.

**JSON Schema is the checker's native input.** Nested objects, list and map element types, unions and
`dyn` are carried through, and value types are real types with their own operators, comparisons,
conversions and member access rather than empty wrappers. *Verify:* a typo two levels into a rule
subject is an error rather than `RESOURCE_RULE_UNEXERCISED`; a byte stream at a string-stream slot is
`CEL_TYPE_ARGUMENT_MISMATCH`; `Telo.HostPath` keeps rejecting a plain string, and `30d` arithmetic
type-checks.

**The standard library and the conformance corpus are data**, one entry per function carrying its
signatures, category, summary, `deterministic` and `hostBacked` flags, with implementations supplied
per runtime — the same posture as the value-type and zone-attribute entries, and the migration
entries. `telo cel functions`, the docs generation, call classification and a future Rust port all
read the one surface, and the corpus is what every port is held to. Scope is the CEL standard library
in full: no protobuf descriptor registry, since nothing in Telo can produce one, and none of cel-go's
optional extension libraries, since Telo's own catalog is the extension layer and a second spelling
of base64 teaches nothing.

**The checker decides, and the classifier collapses.** Owning the checker means a rejection arrives
with its cause and its source range, so `CEL_UNKNOWN_FUNCTION`, `CEL_WRONG_CALL_FORM`,
`CEL_UNKNOWN_IDENTIFIER` and `CEL_TYPE_ERROR` are decided once by the component that knows, and the
after-the-fact explanation disappears. The existing split stands: the engine classifies, the analyzer
decides policy that needs manifest context. *Verify:* every diagnostic code the engine emits today is
emitted with the same code and a source range, and nothing reads a message string.

**The parser owns error recovery**, so a half-typed expression yields a usable tree for completion
and hover instead of being retried against shortened prefixes, and the package's tree is the
canonical one — the analyzer's translation layer, which exists only because the tree was
third-party, goes away. Splitting `${{ }}` holes out of a YAML scalar stays where it is; that is not
CEL.

**The environment keeps its shape** — parse, check, clone, variable/function/type registration,
definition listing, variable lookup — gaining removal, deep schema-typed variables, and the backend
seam. Call sites adapt where the shape is genuinely wrong, not otherwise.

**One cutover, no flag**: two engines behind a switch is two sets of semantics to hold in agreement.
*Verify:* the conformance corpus is green on both backends, `pnpm run test` passes over all existing
manifest tests, `telo check` and the editor surfaces report what they reported before, and nothing in
the tree depends on the third-party engine.

## Decisions

- **Its own top-level package, not a subdirectory of templating** — the analyzer, the SDK and
  `ide-support` already reach the engine directly rather than through templating, and the Node/Rust
  one-for-one layout rule wants a package of its own.
- **Semantics in a support library, backends only wire calls into it** — the alternative, two
  backends each implementing every operator, is two implementations to keep in agreement, and makes
  the Rust port a third.
- **Emitted JS cached under `.telo/cel/`, never published** — rejected: shipping generated code in
  the artifact, which fixes a module's semantics to one emitter version and makes publishing for
  another runtime require that runtime's emitter.
- **An eval-free backend as well as the emitter** — the analyzer evaluates rule conditions and must
  run in a browser, so an emitter alone would retire static rule checking there.
- **Standard library registered like everything else** — rejected: a privileged standard library with
  an override escape hatch, which is the shape that produced the unoverridable `duration` in the
  first place.
- **Signatures and the corpus as data, implementations per runtime** — a port then inherits the
  surface and the acceptance gate, and the docs cannot drift from the registration.
- **No protobuf descriptors, no cel-go extension libraries** — nothing in Telo produces a descriptor,
  and the extensions duplicate Telo's catalog under different names.
- **On the telo version line** — the engine's content is bound to exactly one manifest surface
  generation, which is the membership test.
