# `listeners`: protocol-aware inbound declarations

Replace the Application `ports:` block with a richer `listeners:` block that
declares, per inbound endpoint, the **application protocol**, the **port**, and
the **bind interface**. This is the single source of truth read by three
consumers: the kernel (CEL scope), the analyzer (validation + branding), and the
runner (how to expose it).

## Why

Two latent defects today:

1. **Silent loopback unreachability.** A server bound to `127.0.0.1` is valid for
   a local `telo run` but unreachable once a runner exposes the port — it
   surfaces only as a downstream `502`, far from the cause. The bind interface
   lives on the serving resource, divorced from the port declaration, so nothing
   can flag the contradiction.
2. **`tcp` conflated with HTTP.** The k8s-runner HTTP-fronts *every* tcp port
   ([ingress.ts](../../../apps/k8s-runner/src/k8s/ingress.ts)), so a raw-tcp
   service (e.g. mqtt) gets a bogus HTTP ingress + `https://` URL that cannot
   work. The transport (`tcp`) doesn't tell the runner how to route.

Declaring the application protocol and folding the bind interface into the same
entry fixes both: a `listeners` entry is inbound-and-exposed *by definition*, so
a loopback bind is statically contradictory, and the protocol tells the runner
the correct exposure.

## The `listeners` block

Application-only (Libraries don't get it), mirroring `ports:`.

```yaml
listeners:
  api:
    protocol: http                 # required; from the fixed enum below
    port:
      env: PORT                    # host env var
      default: 8080                # used when env unset
    host:                          # optional; defaults to 0.0.0.0
      env: HOST
      default: "0.0.0.0"
  events:
    protocol: mqtt
    port: { env: MQTT_PORT, default: 1883 }
```

Resolved at `kernel.load()` (extending `resolveApplicationEnv`) into the CEL
scope `listeners.<name>.{port, host}`. Resolution failures (port range, malformed
host, unknown protocol) aggregate into `ERR_MANIFEST_VALIDATION_FAILED`, as
`ports`/`variables` do today.

Serving resources source both from the listener:

```yaml
host: !cel "listeners.api.host"
port: !cel "listeners.api.port"
```

This replaces the integer scope `ports.<name>` with the object scope
`listeners.<name>.port` — a breaking CEL-shape change (see Migration).

## Protocol enum + table

A fixed enum, owned by the analyzer (browser-safe), imported by kernel and
runner. Each protocol resolves to `{ transport, routing }`. `transport`
(`tcp`/`udp`) drives the analyzer brand; `routing` drives runner exposure.

**Exposed** — runner creates the per-session Ingress + URL:

| protocol | transport | routing | note |
| --- | --- | --- | --- |
| `http` | tcp | http | HTTP/1.1 & /2; carries REST, GraphQL, SSE, WebSocket, MCP-streamable |
| `grpc` | tcp | grpc | gRPC over HTTP/2 — distinct ingress backend |

**Declared-only** — valid + branded, but `routing: none` (no external exposure):

- Messaging / IoT: `mqtt` (tcp), `amqp` (tcp), `stomp` (tcp), `coap` (udp)
- Mail: `smtp` (tcp), `imap` (tcp), `pop3` (tcp)
- Realtime / media: `sip` (udp), `rtsp` (tcp), `rtp` (udp), `xmpp` (tcp), `irc` (tcp)
- Infra / naming / time / mgmt: `dns` (udp), `ntp` (udp), `snmp` (udp), `syslog` (udp), `ldap` (tcp)
- Remote access / transfer: `ssh` (tcp), `ftp` (tcp), `telnet` (tcp)

**Raw escape hatches:** `tcp` (tcp), `udp` (udp) — `routing: none`.

`ws` is **not** an entry: WebSocket upgrades on the http-server's existing `http`
listener (same port, same ingress). Same for any http-carried protocol. A
protocol earns an entry only if it's a distinct bound port with its own serving
resource.

Excluded (3rd-party server wire protocols Telo won't implement): `redis`,
`postgres`, `mysql`/`mariadb`, `mongodb`, `memcached`, `cassandra`, `kafka`,
`nats`, `etcd`, `elasticsearch`, `clickhouse`.

## Loopback diagnostic

New analyzer diagnostic (`LISTENER_LOOPBACK_BIND`, error): a `listeners.*` entry
whose `host.default` (or literal host) is a loopback address
(`127.0.0.1` / `localhost` / `::1`) — contradictory for an inbound-exposed
endpoint. The env binding (`host.env`) is the supported way to vary the interface
per environment; the *default* must stay reachable.

## Work by package

- **analyzer** — owns the change's core:
  - protocol enum + `{transport, routing}` table (new module, the shared source
    of truth);
  - `listeners` schema in [builtins.ts](../src/builtins.ts) (replaces `ports`);
  - brand `listeners.<name>.port` by the protocol's transport via the table,
    extending [cel-environment.ts](../src/cel-environment.ts) `PROTOCOL_BRAND`
    and [schema-compat.ts](../src/schema-compat.ts) (brands unchanged:
    `TcpPort`/`UdpPort`);
  - `LISTENER_LOOPBACK_BIND` diagnostic.
- **kernel** — `resolveApplicationEnv` resolves `listeners` (port int + host
  string + protocol) into the `listeners.*` CEL scope; drop the old `ports.*`
  scope.
- **http-server module** — wire `host`/`port` from `listeners.*` in schema docs +
  examples; the `host` default stays `0.0.0.0`.
- **runner-core** — `PortMapping` carries the application `protocol`; the `/v1`
  session contract enum ([contract.ts](../../../packages/runner-core/src/contract.ts),
  [routes/sessions.ts](../../../packages/runner-core/src/routes/sessions.ts))
  widens from `tcp|udp` to the protocol enum; import the analyzer table to map
  protocol → routing.
- **k8s-runner** — exposure switches on `routing`: `http`/`grpc` get an Ingress +
  URL (`grpc` with the gRPC backend annotation), everything else gets neither
  ([ingress.ts](../../../apps/k8s-runner/src/k8s/ingress.ts) `endpointsFor` +
  `buildSessionIngress`). Pod still declares all ports as containerPorts.

## Migration & versioning

Breaking, pre-1.0 → minor. `ports:` → `listeners:`, `ports.X` → `listeners.X.port`
across kernel, analyzer, http-server module, examples, tests, and runner contract.
Changesets for the affected published packages; a changie fragment for the
http-server module.

## Out of scope (future)

- L4 exposure for non-http/grpc protocols (nginx tcp-services / NodePort / LB).
- WebSocket upgrade handler / `Grpc.Server` resources (the protocols are reserved
  now; the serving resources come later).
- Runtime reachability probe in the runner (turn a refused connection on a
  declared port into an actionable session log) — complementary to the static
  diagnostic.
