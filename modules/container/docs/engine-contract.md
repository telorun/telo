# The engine and readiness contracts

`Container.Instance` drives two kinds of collaborator through method contracts,
exported as TypeScript types from the module's code specifier
`@telorun/container`. Importing them is optional: an engine and a readiness
check are recognised by their methods alone (`isContainerEngine`,
`isContainerReadiness`), never by their class, so an implementation may live in
another module, repository or bundle.

## Container.Engine

An engine runs containers and answers for them; it decides nothing. Deadlines,
readiness, expiry, the reachability rule and every error code are
`Container.Instance`'s, decided once for every engine. Every method that talks
to the engine takes an `AbortSignal` last; a start past its deadline aborts it.
A failure is thrown as it arrives, its message saying what the engine answered.

| Method | Resolves with | Notes |
| --- | --- | --- |
| `ping(signal?)` | nothing | Rejects when the engine cannot be reached or refuses to answer, the message naming where it was looked for. |
| `hasImage(image, signal?)` | `boolean` | Whether the engine holds the image. |
| `pullImage(image, signal?)` | nothing | Rejects when the pull failed. An image with no tag is `latest`. |
| `create(spec, signal?)` | container id | Not started. `spec`: `image`, `command?`, `entrypoint?`, `env`, `user?`, `ports`, `labels`. Each of `ports` is bound on the engine's loopback interface to a port the engine chooses. |
| `start(id, signal?)` | nothing | |
| `inspect(id, signal?)` | `{ running, exitCode, bindings }` | `exitCode` is `null` while running. `bindings` maps a container port to `{ host, port }`: the binding the engine reports, which is the address at which the requester reaches the port. A port with no binding is absent. |
| `logs(id, { follow, tail? }, signal?)` | `AsyncIterable<string>` | Standard output and standard error interleaved as text. With `follow` it ends when the container stops. |
| `list(label, signal?)` | `[{ id, labels }]` | Every container, running or not, carrying the label key. |
| `remove(id, signal?)` | nothing | Force-removes the container and its anonymous volumes. A container that no longer exists, or is already being removed, is not a failure. |

**The binding is the address.** An engine reports, for each published port,
where the party that created the container reaches it — a local daemon its
loopback binding, an engine served to a runner session the address that session
reaches the container at. `Container.Instance` reads nothing else, and a missing
binding or an unspecified address (`0.0.0.0`, `::`) fails the start with
`ERR_CONTAINER_START_FAILED`.

## Container.Readiness

```ts
waitUntilReady(target: { logs(signal): AsyncIterable<string> }, signal: AbortSignal): Promise<boolean>
```

Resolves `true` once the container is ready, `false` when its output ended
first (it stopped), and stops when `signal` aborts. `target.logs` streams the
container's output from its start. A readiness kind is a `Telo.Provider` that
`extends: Container.Readiness`; `Container.LogReady` is the one shipped here.
