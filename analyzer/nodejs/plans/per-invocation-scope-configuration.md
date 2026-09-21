# Per-invocation scope configuration

## Problem

A `with:` scope creates its resources when an invocation of its owner enters the scope, and tears them down when it leaves. Each run gets its own instances. So a scope is the natural home for a resource whose configuration belongs to one invocation: a credential a caller supplies, an endpoint chosen per request, a tenant's connection. Three gaps stop it being used that way.

1. **A scoped declaration cannot read the invocation that created it.** Its fields expand against the module's scope alone, meaning `variables`, `secrets` and `resources`. The owner's step body, a few lines below, already sees `inputs`. The only way to configure a scoped resource per call is therefore not to scope it, which puts the value back at module level where every caller shares it.
2. **A stream produced by a scoped resource can leave the scope unchecked.** A sequence's `outputs:` can return it, and a detached dispatch can carry it away. The consumer then pulls after the producer was torn down, and the failure is whatever the disposed resource happens to throw, reported far from the line that caused it.
3. **`x-telo-sensitive` stops at a forwarding slot.** Several kinds take a payload in their own invocation contract and dispatch it as the inputs of the resource in one of their ref slots. A lease, an idempotency claim, a detach and a cache wrapper all do this. Their contract declares that property as an open bag, so a credential passing through one is carried verbatim on the `--inspect` debug wire, even when the target's contract marks it sensitive.

The authoring agent's bring-your-own-key design is the first consumer of all three. None of the three is specific to it.

## Solution

### 1. A scope reads its opening invocation's `inputs`

*Before:* a field of a resource declared in a `with:` block sees `variables`, `secrets` and `resources`. Reading `inputs` there is an unknown identifier.

*After:* a scoped declaration's **creation-time fields** can read `inputs`: the inputs of the invocation that opened this run of the scope. Creation-time fields are those marked `x-telo-eval: compile`, plus every field of a provider, which is implicitly compile. The value is exactly what the owner's step body sees: validated against the owner's bound invocation contract, with its declared defaults filled.
- **Typing:** the same reader that types `inputs` in the owner's step body types it here, so the two cannot disagree. An undeclared field is `CEL_UNKNOWN_FIELD`.
- **Opened by `run()`:** a scope opened by an owner invoked with no inputs (a sequence run as a boot target) sees the contract's defaults over an empty object, as its step body does.
- **Lifetime:** evaluated once per scope entry, when the scoped resource is created. A scoped resource never re-reads `inputs` mid-scope, and two concurrent runs each see their own.
- **Runtime-eval fields are unchanged.** A runtime-eval field of a scoped resource is evaluated per call of that resource. Many such fields already bind an `inputs` of their own, meaning that resource's own call. Binding the opening invocation's inputs there too would make one name mean two things at one site. A value a per-call field needs from the opening invocation is lifted into a creation-time field.
- **`steps` is not bound.** Scoped resources are created at scope entry, before any step has run.
- **Static consequence:** a creation-time field that reads `inputs` is no longer a constant known at load. Every analyzer pass that resolves a creation-time value statically treats an `inputs`-dependent one as unresolved. This is the same treatment it gives a field reading another resource's published state. It covers resource rules, a ref slot's use chosen by a sibling field, and value checks against literals. For a use case map, unresolved means the union of its cases.
- **Kernel:** opening a scope takes the opening invocation's inputs as an explicit argument, part of the SDK's scope-handle surface. The kernel binds them into the scope's creation-time evaluation. `Run.Sequence`, the only stdlib kind that declares a scope, passes its invocation's inputs.
- **Controller defect:** a scope whose declarations read `inputs`, opened without them, fails at scope entry with `ERR_SCOPE_INPUTS_MISSING`. The error names the owning kind, whose controller did not pass them. This is a controller defect and not a manifest one, which is why it has no `telo check` twin: there is no line in the author's YAML to point at.
- **Editor:** the editor's CEL scope query offers `inputs` at exactly these sites, completion and hover included, resolved the same way the checker resolves it.

*Verify:*
- A sequence whose `with:` declares an `HttpClient.BearerToken` with `token: !cel "inputs.key"`, invoked twice concurrently with two keys, sends each key on its own call only.
- Reading an undeclared field fails `telo check` with `CEL_UNKNOWN_FIELD` at that line. At runtime the same manifest fails at scope entry.
- A scoped resource's `detach:` field that reads `inputs` puts both of its ref slot's uses into the call graph.
- Completion in that field lists the owner's declared input fields.

### 2. A scoped stream may not leave its scope

*Before:* nothing stops a stream produced by a scoped resource from being returned from the sequence or handed to detached work. The consumer's first pull after teardown fails, with no message about why.

*After:* a static refusal, and a runtime twin that names the same cause.

**What counts as a scoped stream.** A value of stream type (`x-telo-type: Telo.Stream`) that comes from the result of invoking a resource declared in the scope. Provenance propagates conservatively:
- a `value:` step whose expression reads a scoped stream produces a scoped result;
- a step whose inputs carry a scoped stream produces a scoped result wherever that result is itself stream-typed. A derived stream pulls from its source, so a mapped scoped stream is bound to the scope as tightly as the original.

This is complete for CEL, not a heuristic. CEL cannot construct or transform a stream, so a stream moves only by being referenced, and every reference is visible in the expression.

**`SCOPED_STREAM_ESCAPES_SCOPE`** is reported where a scoped stream is written into either of two places:
- **(a)** a field of the scope's owner outside its scope regions. For `Run.Sequence`, that is `outputs:`.
- **(b)** the inputs of a dispatch whose use at that site is `detached` or a trigger. Such work outlives the call, and so the scope.

The message names the producing scoped resource, the escaping site, and the two fixes: drain the stream inside the scope, or declare its producer outside the scope.

**`ERR_SCOPED_STREAM_CLOSED`** is the runtime twin. For a scoped resource's invocation, the kernel wraps each stream-typed path of its output. It knows these paths from the bound output contract, the same way it knows sensitive paths. A pull after the scope's teardown raises this error, naming the resource and the scope's owner. Only scoped producers pay for the wrapper, and a wrapper costs one flag check per pull.

*Verify:*
- A sequence returning a scoped model stream from `outputs:` fails `telo check` with the code at the `outputs:` line.
- The same manifest run raises `ERR_SCOPED_STREAM_CLOSED` on the caller's first pull.
- A sequence that drains the stream inside the scope, which is how the authoring agent's turn body works, passes both.
- A derived stream built from a scoped one is refused the same way.

### 3. Sensitivity marks survive a forwarding slot

*Before:* a kind that dispatches part of its own invocation payload as another resource's inputs declares that part as an open property. Its trace carries it verbatim, whatever the target marks sensitive.

*After:* a new annotation, **`x-telo-forwards-to`**, placed on a contract property or on the contract root. It states that this value is dispatched as a ref slot's target inputs. It takes two forms:
- **a pointer string** naming the ref slot in the kind's own schema (anchored like a use case map's `by:`), when the value becomes the target's whole inputs;
- **`{ slot, at }`**, when the value lands at pointer `at` inside the target's inputs.

It has two readers, one in the kernel and one in the analyzer, like `x-telo-sensitive`:
- **Kernel trace path:** when it redacts an instance's input payload, the forwarded value is redacted by the target instance's own input-sensitive paths. The target is resolved from the instance's slot, per call where the slot is chosen dynamically. A target that cannot be resolved withholds the forwarded value whole, which is the existing rule for a contract that cannot be resolved.
- **Analyzer:**
  - It validates the annotation's placement and its pointer. `FORWARDS_TO_INVALID` is reported when the pointer names no ref slot of the same kind. `FORWARDS_TO_MISPLACED` is reported when the annotation sits anywhere but a contract.
  - The kernel refuses the same declaration at `create()` with `ERR_FORWARDS_TO_INVALID`.
  - Because the annotation names the target, the analyzer also checks the forwarded value a caller writes against that target's input contract wherever the target resolves statically, reporting `FORWARDED_INPUT_MISMATCH`. Today that payload is checked against nothing.

The kind that forwards declares the annotation. It is never inferred from property names. A property called `inputs` that the kind does not forward is ordinary data.

**Adopters:** every stdlib kind whose contract carries a payload it dispatches into a ref slot. The audit is part of this change, and each candidate is confirmed against its contract rather than assumed from its description. The known candidates are `Lease.Critical`, the idempotency claim, `Run.Detach`, the cache wrapper (which forwards its whole payload, hence the root placement), and `RecordStream.OnComplete` (which forwards `context` into the handler's inputs, hence the `{ slot, at }` form).

*Verify:*
- A lease forwarding `{ modelKey }` into a body whose contract marks `modelKey` sensitive traces `[redacted]` for it under `--inspect`, and the rest of the payload verbatim.
- A forwarded payload missing a field the target requires fails `telo check` with `FORWARDED_INPUT_MISMATCH`.
- An annotation pointing at a non-slot field fails both `telo check` and boot.

## Decisions

- **`inputs` is bound only in creation-time fields of scoped declarations.** A runtime-eval field already has a per-call meaning for that name in many kinds, and one name with two meanings at one site is worse than lifting a value into a creation-time field.
- **The name is `inputs`, not a new one.** It is the same value the owner's step body calls `inputs`, and a second name for one value would split completion, hover and documentation for no semantic gain.
- **The opening inputs reach the kernel as an explicit argument, not through the ambient invocation context.** That context carries identities and never payload, which is the execution-zone rule, so that no controller can read another module's material off it.
- **Stream provenance is conservative.** A resource that consumes a scoped stream and returns an unrelated stream is refused too. It is rare, the fix is stated in the message, and a precise rule would need knowledge of every controller's internals, which static analysis does not have.
- **The runtime twin wraps only scoped producers**, so no module-level stream pays for a check it cannot fail.
- **Forwarding is declared by the forwarding kind**, not inferred. Inference from a property's name or shape would mark data that is never forwarded and miss a forwarder that names its property differently. Marking the whole bag sensitive would blind every forwarded payload to keep one field safe.

## Correctness and edge cases

- **Two concurrent runs of one scope** each bind their own `inputs` at their own entry. The per-run child context already isolates instances, and the binding lives on the same child.
- **A nested scope** sees the inputs of the invocation that opened *it*, not those of an outer scope. A nested sequence's owner is itself.
- **A scoped resource reading `inputs` in a field another pass constant-folds** is unresolved to that pass, never folded to a default. Treating an unknown as its default is how a check passes on a value the runtime will never hold.
- **A stream passed to a module-level resource during the scope** is legitimate, because the call returns before the scope ends. If that resource retains the stream past its call, the runtime twin names the cause at the late pull.
- **A forwarding slot whose target changes between calls** is resolved per call at the trace site, so each trace uses its own target's marks.
- **An older runtime reading a manifest that uses scope inputs** refuses the `inputs` reference as an unknown identifier. The adopter's `requires:` floor turns that into one `MODULE_REQUIRES_NEWER_RUNTIME`.

## Housekeeping

- **Agreement suite.** `tests/check-run-agreement.yaml` gains three rows, each refused by both halves: an undeclared field read in a scope, a scoped stream escaping through `outputs:`, and an invalid `x-telo-forwards-to` pointer.
- **Grammar floors.** Both new surfaces follow the "Changing the grammar" rule, **verified by execution** against the previous published CLI:
  - Every module whose own file reads `inputs` inside a `with:` block declares `requires: telo:` at the release that carries this.
  - Every module adopting `x-telo-forwards-to` declares the floor only if the previous CLI rejects its file. If that CLI accepts and ignores the annotation, no floor is declared: its readers are defence in depth, and the adopting application declares its own floor.
  - The `run` module passes inputs to the scope handle. That is a controller change an older kernel ignores harmlessly, so it needs no floor.
- **Package bumps.** Changesets for the analyzer, the kernel and the SDK (the scope-handle argument), and a `telo release` fragment for `run` and for each adopting module.
- **Documentation:**
  - The `run` module's `with:` documentation.
  - This package's guide: the `x-telo-scope` entry, the CEL-scope list, the new `x-telo-forwards-to` entry beside `x-telo-sensitive`, and the three diagnostics.
  - The kernel guide's scope section.
  - The root guide's annotation list.
- **Authoring agent primer.** The primer gains the rule in the same change. A `with:`-scoped resource may read the enclosing invocation's `inputs` in its creation-time fields, and that, not an invented per-call field on a kind, is how a per-request credential, endpoint or tenant value is carried.
