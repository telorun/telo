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
| `source` | Where the child's manifest is — a path relative to the module declaring this resource, or a published module reference. Always a literal. |
| `variables` | Values for the child's declared `variables:`, keyed by the child's own names. |
| `secrets` | Values for the child's declared `secrets:`. |
| `ports` | Ports for the child's declared `ports:`, keyed by the child's own port names. |

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

The child validates each value against its own declaration, so it stays the authority on what it accepts. A name it does not declare is refused and it exits non-zero, with the names it does declare in the message — a value silently ignored is the failure this prevents. A name you leave out falls back to the environment, then to the child's default.

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

The scope is created when the sequence starts and torn down when it ends, so the port is bound for exactly the length of the test and the run exits on its own. Two tests can each stand up the same application without coordinating, as long as each hands it a port of its own.

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
