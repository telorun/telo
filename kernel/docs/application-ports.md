---
description: "How Telo.Application declares the inbound ports it listens on: name-keyed, env-bound entries that resolve into the ports.<name> CEL scope, with transport brands for static wiring checks."
---

# Application ports

`Telo.Application` accepts a `ports:` block declaring the inbound ports the app listens on. It mirrors [`variables:`](./application-env-variables.md) — a name-keyed map, env-bound, resolved at `kernel.load()` — but is specialised for ports: each value is implicitly an integer in the IANA range (1–65535, no `type:` needed) and surfaces in its own `ports.<name>` CEL scope. `ports:` is **Application-only**; `Telo.Library` does not declare ports.

```yaml
kind: Telo.Application
metadata:
  name: my-api
  version: 1.0.0

ports:
  http:
    env: PORT
    protocol: tcp
    default: 8080
targets: [Server]
---
kind: Http.Server
metadata: { name: Server }
port: !cel "ports.http"
```

Because the binding resource reads `!cel "ports.http"`, the declaration is the single source of truth — and because the `env:` knob is named directly on the entry, a runner or the editor knows which ports the app exposes (and which env var configures each) **before** starting the process.

| Field      | Required | Description                                                                                          |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `env`      | yes      | Name of the host environment variable supplying the port number.                                     |
| `protocol` | no       | `tcp` (default) or `udp`. Selects the transport and the value's nominal type (see below).            |
| `default`  | no       | Fallback port used when the env var is unset. Missing env var with no default fails `kernel.load()`. |

Resolution mirrors `variables` exactly: read the env var, coerce as an integer, validate against the 1–65535 range, and fall back to `default` when unset. Failures aggregate into the same `ERR_MANIFEST_VALIDATION_FAILED` error.

A declared port that no CEL expression references is flagged with an `UNUSED_DECLARATION` warning — an unbound port is dead weight and would make a runner advertise a port the app never listens on. See [Application Environment Variables](./application-env-variables.md#unused-declarations).

## Typed values and static wiring checks

The analyzer brands each resolved port value by its `protocol`: `tcp → TcpPort`, `udp → UdpPort`. These are **nominal** types — structurally identical (both integers) but intentionally distinct — that exist only for static analysis; at runtime the value is a plain integer, so there is no runtime cost.

A resource field can declare which brand it accepts with the analyzer-only `x-telo-type` annotation in its `Telo.Definition` schema (e.g. `http-server`'s `port` is branded `TcpPort`). Wiring a `UdpPort` into a `TcpPort`-branded field is then a static error:

```txt
CEL returns 'UdpPort' but field expects 'TcpPort'
```

`x-telo-type` is a general value-brand mechanism, not port-specific — the same annotation can brand other value shapes in future (`Url`, `Duration`, …). Standard JSON Schema keywords (`type`, `minimum`/`maximum`) still perform the actual validation; the brand only carries the nominal identity. A plain integer flows freely into a branded field (gradual typing); only a _conflicting_ brand is rejected.
