---
status: draft
priority: high
depends-on: []
packages: [analyzer, kernel, sdk, templating]
---

# Per-invocation scope configuration

## Problem

A `with:` scope creates its resources when an invocation of its owner enters the scope, and tears them down when it leaves. Each run gets its own instances. So a scope is the natural home for a resource whose configuration belongs to one invocation: a credential a caller supplies, an endpoint chosen per request, a tenant's connection. Three gaps stop it being used that way.

1. **A scoped declaration cannot read the invocation that created it.** Its fields expand against the module's scope alone, meaning `variables`, `secrets` and `resources`. The owner's step body, a few lines below, already sees `inputs`. The only way to configure a scoped resource per call is therefore not to scope it, which puts the value back at module level where every caller shares it.
2. **A stream produced by a scoped resource can leave the scope unchecked.** A sequence's `outputs:` can return it, and a detached dispatch can carry it away. The consumer then pulls after the producer was torn down, and the failure is whatever the disposed resource happens to throw, reported far from the line that caused it.
3. **`x-telo-sensitive` stops at a forwarding slot.** Several kinds take a payload in their own invocation contract and dispatch it as the inputs of the resource in one of their ref slots. A lease, an idempotency claim, a detach and a cache wrapper all do this. Their contract declares that property as an open bag, so a credential passing through one is carried verbatim on the `--inspect` debug wire, even when the target's contract marks it sensitive.

4. **A resource configured from request-time data cannot be shared, and cannot reach deep consumers.** A cluster's client built from a kubeconfig in a database, or a tenant's connection, can only be built per call in a `with:` scope, rebuilt with its connections on every call, and every resource using it must be redeclared in that scope while the cluster or tenant id is threaded through every contract down to it.
5. **A reference can only name a resource, an import's export or a family member.** It cannot name a resource that another resource holds in a field, such as a route of an API or the resource a pool builds.

The authoring agent's bring-your-own-key design is the first consumer of the first three; a Kubernetes connector serving many clusters from kubeconfigs stored in a database, and multi-tenant applications holding one connection per tenant, are the first consumers of the last two. None of the five is specific to either.

## Solution

**Warning**: This is just a draft, and idea, not a plan to implement, it needs major refinement.

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

### 4. A pool builds a resource per key, and a checkout chooses the key

*Before:* a resource whose configuration is known only during a call — a cluster's client built from a kubeconfig stored in a database, a tenant's database connection — can be built only per call, inside a `with:` scope, together with its connections and TLS sessions. Every resource that uses it has to be redeclared in that scope, and the tenant or cluster id has to be passed down through every contract between the request's edge and the place it is used.

*After:* two new built-in kinds. **`Telo.Pool`** says how one member is built from a key and keeps the members it built. **`Telo.Checkout`** chooses the key for the steps it runs, so every resource those steps reach that depends on the pool uses that key's member. No consumer kind declares anything.

**`Telo.Pool`**
- **Fields:**
  - `steps`: the shared step grammar, run only when a key has no member. It reads `key`, typed `string`.
  - `resource`: one full resource declaration, written as in a `with:` block. Its kind resolves through the declaring module's imports, it is validated as a top-level resource, and its creation-time fields read `key` and `steps.<name>.result`.
  - `idleTimeout` (default `5m`), `maxAge` (no default; absent means members never age out) and `maxEntries` (default `64`).
- **What it can pool:** the `resource` must be a `Telo.Provider` or a `Telo.Invocable`. Anything else is `POOL_RESOURCE_CAPABILITY`, and `ERR_POOL_RESOURCE_CAPABILITY` at creation.
- **Building a member:** a key with no member runs `steps`, then creates `resource`. Concurrent checkouts of one key wait for the same build, so it runs once. The build runs under the root invocation context, so no caller's cancellation, transaction or zone reaches it. One waiter cancelling abandons only its own wait; the build is cancelled only when no waiter is left. A failed build caches nothing, and the next checkout of that key builds again. Miss `steps` that reach the pool's own members are `DEPENDENCY_CYCLE`.
- **Lifetime of a member:**
  - A member with no holds is torn down through its normal inverse chain after `idleTimeout`.
  - After `maxAge` a member is retired: later checkouts of its key build a new member, and the retired one is torn down when its last hold is released.
  - `maxEntries` bounds the live members. A checkout of a new key while every member is held fails at once with `ERR_POOL_EXHAUSTED`, declared retryable; when some member is idle, the least recently used idle member is evicted to make room.
  - Idle and age timers take no kernel hold. Shutdown tears every member down after the checkouts holding them have ended.
- **Reference:** a reference slot names the member as `!ref <pool>.resource`, or `!ref <Alias>.<pool>.resource` for a pool an imported library exports (section 5).

**`Telo.Checkout`**
- **Fields:** `pool` (a `!ref` to a `Telo.Pool`), `key` (CEL over the checkout's own `inputs`, evaluated when the checkout is invoked), and the contract keys of `Telo.Sequence`: `inputType`, `outputType`, `steps`, `outputs`. It has no `with:` and no `targets:`. It is a `Telo.Invocable`, so it is declared like any resource, inline as a route handler or step target or named at top level.
- **Zone:** its `steps` body provides a zone correlated on its `pool`. The zone entry holds only the checkout's and the pool's identities, never the key; the pool keeps its own map from zone entry to member.
- **Holding:** invoking a checkout evaluates `key`, takes a hold on that key's member (building it when needed) and runs `steps`. The hold is released when the checkout returns, and only after every stream its result holds has settled (below).
- **Nesting:** a checkout inside another checkout of the same pool takes over for its body; the innermost one decides. A dispatch therefore uses one member per pool. Using two members of one recipe at once means two pools.

**Member-bound declarations**
- **Which they are**, computed statically from the reference graph:
  - a pool's `resource`;
  - any declaration that holds a member-bound declaration in a `use: dependency` slot or reads one in a creation-time field, transitively.
  
  An `Http.Request` whose `client` names `clusters.resource` is one, as is an `Sql.Query` whose `connection` names a pooled connection, an `Sql.Transaction` over it, a resource inside an imported library whose `resources:` input is supplied with `!ref tenants.resource`, and a template body entry that reaches one.
- **Routing:** a dispatch of a member-bound declaration goes to that declaration's instance in a child context that belongs to the member the innermost checkout of its pool holds. That instance is created the first time it is dispatched for that member, lives as long as the member, and is torn down with it. So a member-bound declaration is created once per member, not once per call, and its controller is unchanged: a reference slot it reads, at creation or on every call, resolves inside that child context to that member.
- **Transactions:** an `Sql.Transaction` over a pooled connection is itself member-bound, so its zone correlation resolves to the same member's connection its statements use.
- **Outside a checkout:** a reach of a member-bound declaration that no checkout of its pool covers is `ZONE_REQUIREMENT_UNSATISFIED`, and `ERR_ZONE_REQUIRED` at run time; both messages name the pool and the chain of references that made the declaration member-bound. That covers a dispatch, a detached or trigger dispatch (both start with no zones), a runtime-eval `resources.<name>` read, a boot target, a Service, Mount or Sink holding one, and a callable's data slot.

**Streams**

A stream a member-bound declaration returns, at a stream-typed path of its bound output contract, keeps the checkout's hold until it settles: finished, failed, or cancelled by its consumer. The member is never torn down under it. So a Kubernetes watch can be returned from a route handler to an SSE response, and closing the connection releases the member. Section 2's refusal applies to `with:` scopes only, not to checkouts. A stream at a path the contract does not type as `Telo.Stream` is not tracked. A stream nobody ever settles keeps its member held; `maxEntries` bounds that as `ERR_POOL_EXHAUSTED` instead of growing memory. Teardown releases every hold an open stream still owns.

**Durable execution:** a checkout's key is a journaled decision, so a replay checks out the same key. A member-bound step target is refused at the sender, as a `with:`-scoped one already is.

**Rust kernel:** refuses `Telo.Pool` and `Telo.Checkout` with `ERR_UNSUPPORTED_MANIFEST_FEATURE`.

*Example:* an application that lists the pods of one cluster, its kubeconfig stored in a database. Every call for the same cluster id uses the same `Http.Client` and the same `Http.Request` instance; the database is read and the kubeconfig parsed only when that id has no member.

```yaml
kind: Telo.Application
metadata: { name: K8sDashboard }
imports:
  Sqlite: oci://ghcr.io/telorun/sqlite@0.0.0
  Sql: oci://ghcr.io/telorun/sql@0.0.0
  Yaml: oci://ghcr.io/telorun/yaml@0.11.1
  Http: oci://ghcr.io/telorun/http-client@0.0.0
variables:
  database: { env: DATABASE_FILE, type: string, x-telo-type: { name: Telo.HostPath, entry: file } }
  clusterId: { env: CLUSTER_ID, type: string }
targets:
  - invoke: !ref listPods
    inputs: { clusterId: !cel "variables.clusterId" }
---
kind: Sqlite.Connection
metadata: { name: db }
file: !cel "variables.database"
---
kind: Telo.Pool
metadata: { name: clusters }
idleTimeout: 5m
maxAge: 1h
maxEntries: 64
steps:
  - name: row
    invoke: { kind: Sql.Query, connection: !ref db }
    inputs: { sql: !sql "SELECT kubeconfig FROM clusters WHERE id = ${{ key }}" }
  - name: missing
    if: !cel "size(steps.row.result.rows) == 0"
    then:
      - name: notFound
        throw:
          code: CLUSTER_NOT_FOUND
          message: !interpolate "No cluster with id ${{ key }}"
          data: { clusterId: !cel "key" }
  - name: config
    invoke: { kind: Yaml.Parse }
    inputs: { text: !cel "steps.row.result.rows[0].kubeconfig" }
resource:
  kind: Http.Client
  baseUrl: !cel "steps.config.result.docs[0].clusters[0].cluster.server"
  headers: { Authorization: !interpolate "Bearer ${{ steps.config.result.docs[0].users[0].user.token }}" }
---
kind: Telo.Checkout
metadata: { name: listPods }
inputType:
  type: object
  required: [clusterId]
  properties: { clusterId: { type: string } }
pool: !ref clusters
key: !cel "inputs.clusterId"
steps:
  - name: get
    invoke: { kind: Http.Request, client: !ref clusters.resource }
    inputs: { method: GET, url: /api/v1/pods }
outputs: !cel "steps.get.result.body"
```

The same checkout as an `Http.Api` route handler is declared inline, its `inputs` mapped from `request.params.clusterId`, and holds the member for exactly one request.

*Verify:*
- **Building:** a fixture provider counting its constructions, pooled: three checkouts of one key build one member, two keys build two, concurrent first checkouts of one key run `steps` once, and a failed build is retried by the next checkout.
- **Routing, multi-tenant:** two concurrent requests for two tenants each read their own SQLite file through an unmodified `Sql.Query` whose `connection` names the pooled connection — once with the query at module level, once inside an imported library supplied with `resources: { connection: !ref tenants.resource }`, once inside an `Sql.Transaction`, whose statements join that transaction.
- **Per member, not per call:** the `Http.Request` in the example is created once per cluster id across many calls.
- **No consumer change:** no stdlib controller or kind schema changes for any of the above.
- **Outside a checkout:** dispatching a member-bound declaration from a boot target, and from a detached dispatch, fails `telo check` and boot, naming the pool.
- **Lifetime:** after `idleTimeout` with no hold the fixture records one teardown, before it none; a member past `maxAge` while held is torn down only when released, and the next checkout builds a new one; with `maxEntries: 1`, one held member and a new key fail at once with `ERR_POOL_EXHAUSTED`.
- **Streams:** a watch streamed to an SSE client keeps its member past `idleTimeout`; it is torn down `idleTimeout` after the client disconnects, and not before.
- **Capability:** a `Telo.Service` as a pool's `resource` fails `telo check` and boot.

### 5. A reference names a member of a resource

*Before:* a `!ref` is `<name>`, `<Alias>.<name>` or `<family>[<binding>.key]` / `[<binding>.index]`; any other text is `REF_MEMBER_INVALID`.

*After:* the grammar accepts a member path after the name of a local resource. A segment is `.<name>`, `[<integer>]` or `[<field>=<value>,…]`:
- `!ref clusters.resource` — the member a pool builds (section 4); `!ref Clusters.clusters.resource` for a pool an imported library exports.
- `!ref api.routes[0]` — the item at a position in a list.
- `!ref api.routes[method=GET,path=/some/path]` — the one item whose fields hold those values.

Rules:
- **Head:** an alias and a local resource share one namespace, so a head naming an import alias keeps reading as `<Alias>.<name>`, and one naming a local resource starts a member path. The resolver decides which, since the parser has no context; the parser yields the segments. A member path may also follow `<Alias>.<name>` when that export is a resource; a path past a family member is `REF_MEMBER_INVALID`.
- **What a path names:** a resource the head's declaration holds in a field, extracted from an inline declaration written there (the origin recorded at extraction), or a pool's `resource`. Anything else — a scalar, plain data, a field holding no resource — is `REF_MEMBER_UNRESOLVED`, listing what the head does hold.
- **Selector:** a `<field>` is a top-level identifier of the member. A bare value uses the characters `A-Za-z0-9_./:{}-`; any other value is written in single quotes, `''` escaping a quote. The value is compared as text with the member's written literal, every listed field must match, and the position of an integer index is the item's place among the list's items.
- **Exactly one:** no match is `REF_MEMBER_UNRESOLVED` naming the values found for that field; more than one is `REF_MEMBER_AMBIGUOUS` naming how many. A field holding an expression, or whose value is only a schema default, is `REF_MEMBER_NOT_LITERAL` — it never matches by default, so `[method=GET]` cannot match a route that merely omits `method`.
- **Edges:** a reference to a member is a reference to that resource everywhere a `!ref` is legal, template bodies included, and counts as a dependency of the head for creation order and the call graph.
- **Kernel:** resolves the same text the same way and raises `ERR_REF_MEMBER_UNRESOLVED`, `ERR_REF_MEMBER_AMBIGUOUS` and `ERR_REF_MEMBER_NOT_LITERAL`. Both parsers and the `!ref` conformance vectors carry the grammar.

The first consumer is the pool's `resource`. Routes of `Http.Api` use the same references once they become resources, which is a change of that module and not of this plan.

*Verify:*
- Parser vectors in both languages for each form, the quoting, `''`, and the refusals.
- A reference by index and by selector each resolve to the right resource under `telo check` and at boot.
- Zero matches, two matches and a computed field each fail with their own code in both halves.
- Inserting an item before the referenced one leaves a selector reference valid and breaks an index reference only if the position changed.

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

- **Agreement suite.** `tests/check-run-agreement.yaml` gains one row for each refusal, each refused by both halves: an undeclared field read in a scope, a scoped stream escaping through `outputs:`, an invalid `x-telo-forwards-to` pointer, a pool of a kind outside `Telo.Provider` / `Telo.Invocable`, a member-bound declaration reached outside a checkout (from a boot target and from a detached dispatch), and each of the three member-reference refusals.
- **Grammar floors.** The new surfaces follow the "Changing the grammar" rule, **verified by execution** against the previous published CLI:
  - Every module whose own file declares a `Telo.Pool` or a `Telo.Checkout`, or writes a member reference, declares `requires: telo:` at the release that carries this. No stdlib kind changes for pooling, so none needs a floor for it.
  - Every module whose own file reads `inputs` inside a `with:` block declares `requires: telo:` at the release that carries this.
  - Every module adopting `x-telo-forwards-to` declares the floor only if the previous CLI rejects its file. If that CLI accepts and ignores the annotation, no floor is declared: its readers are defence in depth, and the adopting application declares its own floor.
  - The `run` module passes inputs to the scope handle. That is a controller change an older kernel ignores harmlessly, so it needs no floor.
- **Package bumps.** Changesets for the analyzer (member-bound declarations, the pool and checkout refusals), the kernel (pools, checkouts, routing by member), the SDK (the scope-handle argument) and `templating` (the `!ref` grammar), and a `telo release` fragment for `run` and each adopting module. The Rust twins of the line carry the same version, and the Rust templating and analyzer twins read the new `!ref` grammar.
- **Built-in vocabulary.** `Telo.Pool` and `Telo.Checkout` are added to the built-in entries and the `Telo.Builtins` archive is re-rendered.
- **Benefits ledger.** One entry under Telo itself in `docs/guides/what-you-get.md`: per-tenant connections and clients behind every request, declared with `Telo.Pool` and `Telo.Checkout`, built once per tenant and reused, with no tenant id passed through the code that uses them.
- **Documentation:**
  - A pool and checkout guide under `docs/extend/`, with the multi-tenant and Kubernetes examples.
  - The templating guide's `!ref` grammar section, and the analyzer guide's reference-form and diagnostics entries.
  - The `run` module's `with:` documentation.
  - This package's guide: the `x-telo-scope` entry, the CEL-scope list, the new `x-telo-forwards-to` entry beside `x-telo-sensitive`, and the three diagnostics.
  - The kernel guide's scope section, and a section on routing member-bound declarations.
  - The root guide's annotation list.
- **Authoring agent primer.** The primer gains the rule in the same change. A `with:`-scoped resource may read the enclosing invocation's `inputs` in its creation-time fields, and that, not an invented per-call field on a kind, is how a per-request credential, endpoint or tenant value is carried. It also gains `Telo.Pool` and `Telo.Checkout` as the way to build one resource per key (a tenant, a cluster) and use it from unchanged resources anywhere beneath the checkout, and the member-reference forms.
