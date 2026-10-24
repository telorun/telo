# `App.Instance`

Another application, running as a resource of this one.

```yaml
kind: App.Instance
metadata: { name: worker }
source: ./worker/telo.yaml
variables:
  instanceId: a
ports:
  http: 8051
```

| Field | Meaning |
| --- | --- |
| `source` | Where the child's manifest is — a path relative to the module declaring this resource, or a published module reference. Always a literal, and followed by `telo check` (below). |
| `variables` | Values for the child's declared `variables:`, keyed by the child's own names. |
| `secrets` | Values for the child's declared `secrets:`. |
| `ports` | Ports for the child's declared `ports:`, keyed by the child's own port names. |
| `needs` | Fulfilments of the child's own `needs:`, keyed by the child's need names: a `!ref` to a need or fulfilment of this module, or a map of the need type's fields. |

Observed state: `status.exitCode` is `null` while the child is running, and the code it exited with once it is gone.

## Lifecycle

The child starts when this resource runs — from the application's `targets:`, or from a `Run.Sequence`'s — and not before, so it orders against migrations and other start-up work like any other service.

Starting waits for the child's own `targets:` to be dispatched, which means a server it declares is already listening: a step that follows can call it without polling or retrying. A child being read as a channel is the exception, and must be — an interactive child blocks on its first prompt, so its targets are never all dispatched, and waiting for that would wait until it was finished. There, the markers a reader waits for are what orders the conversation.

While a child runs it holds the application open, exactly as a listening socket or an armed schedule does. A supervisor whose only resources are children therefore stays up while any of them runs and exits when the last one finishes, with no server bolted on beside it. When the child exits, its hold is released and its code is reported.

Shutting down waits for the child to finish tearing down, so this application never outlives a child still holding a port.

## Inputs are supplied by name

A child declares what it accepts as `variables:` / `secrets:` / `ports:`, each bound to an environment variable. You supply the **declaration name**, not the environment variable:

```yaml
source: ./worker/telo.yaml
variables:
  instanceId: a        # the child's `variables.instanceId`, whatever env var it binds
```

The child's declaration is the authority on what it accepts, and it is read before anything runs: a name it does not declare is refused, with the names it does declare in the message — a value silently ignored is the failure this prevents. A name you leave out falls back to the environment, then to the child's default.

## Needs are supplied by name too

A child is an application of its own: it does not inherit the host values its
parent's kernel-declared needs are answered from (`TELO_HOST_STATE_DIR`,
`TELO_HOST_PUBLIC_URL_TEMPLATE`, `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE`). So
a child that declares a `Telo.DurableDirectory` gets no directory under its
parent's state directory — its parent hands it one under `needs:`, keyed by the
child's need name, in either of the two forms an import's `needs:` takes:

```yaml
kind: App.Instance
metadata: { name: agent }
source: ../telo.yaml
needs:
  agentState:                       # a map of the need type's fields
    path: !cel "variables.scratch.joinPath('agent-state')"
---
kind: Telo.DurableDirectory
metadata: { name: workerState }
fields:
  path: !cel "variables.scratch.joinPath('worker-state')"
---
kind: App.Instance
metadata: { name: worker }
source: ./worker/telo.yaml
needs:
  state: !ref workerState           # a need or fulfilment of this module, whole
```

A need forwarded whole reaches the child as its fields — a need of this
module, a fulfilment it declares, or one an import exports (`!ref
Storage.directory`). In the child, a need supplied by name is answered by that
value alone — before the child's own environment variable and before any host
value — and a `supply: root` type is accepted, since the parent is supplying the
child's root. The child validates the fields against its own need type and
refuses at boot, exiting non-zero, what could not be decided before: a required
field an expression left out (`ERR_NEED_PARTIALLY_SUPPLIED`), and a directory it
cannot use (`ERR_NEED_DIRECTORY_UNUSABLE`, naming this `App.Instance` as where the
value came from). A field the child's need type marks sensitive is redacted in the child's
output. A need left out is read as any root reads it: from the child's own
environment, then refused with `ERR_NEED_UNMET` when nothing answers it.

## Checked before anything runs

`source` carries `x-telo-application-source`, so `telo check` — and the load of
this application, before any resource starts — follows it to the child's
manifest, the way it follows an import, and holds what you supply to what the
child declares:

- a source that cannot be obtained is `IMPORT_UNRESOLVED`, one that is not a
  module reference `INVALID_IMPORT_SOURCE`, and one that is not a
  `Telo.Application` (a library, the built-in vocabulary) `INVALID_IMPORT_TARGET`,
  each at `source`;
- a key of `variables`, `secrets`, `ports` or `needs` the child does not declare
  is `APPLICATION_INPUT_UNDECLARED` at that key, naming what it does declare;
- a literal the child's declaration refuses is `SCHEMA_VIOLATION`; an
  expression is typed against the declaration it fills (`CEL_TYPE_ERROR`) only
  for an `App.Instance` declared at the top level — see the limit below;
- a need forwarded whole must be a need or fulfilment of the child's need type
  (`REFERENCE_KIND_MISMATCH`), and a need of this module must state at least what
  the child's does — its version range, its features, a durable directory's
  access and size (`NEED_FORWARD_INCOMPATIBLE`); a field map is held to the type's
  fields (`NEED_FIELD_UNDECLARED`, `NEED_SLOT_MISMATCH`, `SCHEMA_VIOLATION`).

These checks cover an `App.Instance` wherever it is declared — at the top
level, in a `with:` scope, or inline in a step (`invoke: { kind: Run.Sequence,
with: [ … ] }`, the shape a test takes) — with one limit: an expression handed to
a child declared in a `with:` scope or inline in a step is **not** type-checked
against the child's declarations. Its literals are checked; an expression of the
wrong type there is refused only by the child, when it boots.

The child's own manifest is not checked here — `telo check` it on its own. A kind
extending `App.Instance` through `base:` writes no `source` of its own, so its
members are checked when each child boots.

## Testing an application

An application cannot be imported, so a test reaches one by running it. Declaring it in a sequence's `with:` block ties it to the test:

```yaml
kind: Run.Sequence
metadata: { name: test }
with:
  - kind: App.Instance
    metadata: { name: api }
    source: ../telo.yaml
    ports:
      http: 8931
targets:
  - !ref api
steps:
  - name: call
    invoke:
      kind: HttpClient.Request
      url: http://127.0.0.1:8931/v1/echo?say=hello
      method: GET
  - name: verify
    invoke: { kind: Assert.Equals }
    inputs:
      actual: !cel "steps.call.result.status"
      expected: 200
```

The scope is created when the sequence starts and torn down when it ends, so the port is bound for exactly the length of the test and the run exits on its own. Two tests can each stand up the same application without coordinating, as long as each hands it a port of its own — and, when it keeps state, a directory of its own under `needs:`.

## Several copies

There is no `replicas:` count, and that is deliberate: replicas are addressable peers. A test that stops one replica and asserts another took over needs each to be a resource with its own name, its own `!ref` and its own status path — which a count cannot give. Declare what a replica is once as a kind, then declare the members:

```yaml
kind: Telo.Definition
metadata: { name: Worker }
capability: Telo.Service
extends: App.Instance
schema:
  type: object
  required: [instanceId, port]
  properties:
    instanceId: { type: string }
    port: { type: integer, x-telo-type: Telo.TcpPort }
base:
  source: ./worker/telo.yaml
  variables:
    instanceId: !cel "self.instanceId"
  ports:
    http: !cel "self.port"
---
kind: Self.Worker
metadata: { name: workerA }
instanceId: a
port: 8051
---
kind: Self.Worker
metadata: { name: workerB }
instanceId: b
port: 8052
```

Ports come from the supervisor's own `ports:` block when they should be configurable from outside — that is the allocation surface a runner reads before boot, and the only one it can see.

To stop one member part-way through a test, declare it in a **nested** sequence's `with:`: leaving that sequence tears it down, deterministically, with no signals involved.

## Talking to it

`App.Instance` is a `Channel.Text`, so a running child can be read from and written to as text: `Channel.ReadUntil` waits for a prompt, `Channel.SendLine` answers it, `Channel.End` closes its input so it can finish on its own. The child's stdout is the conversational side; its stderr keeps flowing to this application as the diagnostic stream. See the `channel` module's [Holding a conversation](../../channel/docs/conversations.md).

There is no `stdin:` field. A fixed script handed over at start-up cannot answer a question that only appears once the previous one is answered, and a boot-time script is the first steps of a sequence anyway.

## Related

- `Assert.Manifest` runs a manifest to completion under a hard time bound and pins a static verdict to the runtime one. It is for manifests that are *supposed* to fail; `App.Instance` is for applications that are supposed to work.
