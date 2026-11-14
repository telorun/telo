---
status: draft
priority: medium
depends-on: [2026-11-13-runner-sign-in.md]
packages: [cli/nodejs, packages/runner-core, packages/share-tunnel, apps/k8s-runner]
refinement: ready
---

# Sharing a local run

## Problem

An application run with `telo run` can be reached only from the machine running it. Showing it to someone, testing a webhook, or trying an OAuth callback against a real HTTPS origin all need a third-party tunnel. That tunnel's URL is unknown to Telo, so the app's `Telo.PublicUrl` need still resolves to whatever the env says. Links, redirects and callbacks the app builds point at `localhost` unless the developer copies the tunnel's address into `TELO_NEED_…__URL` by hand. They copy it again each time the tunnel hands out a new one.

The hosted runner (`https://runner.telo.run`) already routes `<port>-<id>.telorun.dev` to session workloads, and it is a template-mode host of `Telo.PublicUrl`. A local run cannot use any of that.

## Surface

**Added**
- `telo run --share[=<name>]`: shares every `tcp` port of the root Application publicly through a runner. `<name>` names the share. Without it, each copy of the manifest gets its own share.
- `telo run --share-runner <url>`: the runner a share goes to. Legal only beside `--share`; alone it is the usage error `--share-runner needs --share`.
- `telo shares list`, `telo shares delete <id>`: list the signed-in user's shares on a runner, or delete one. `--runner <url>` picks the runner.
- `TELO_RUNNER_URL`: the default runner for `--share` and `telo shares`, after `--share-runner` / `--runner`. Without any of them, `https://runner.telo.run`.
- `<per-user state>/telo/share-names.json`: the share name minted per real manifest path.
- CLI refusals:
  - `ERR_RUNNER_SIGN_IN_REQUIRED`: no grant for the runner.
  - `ERR_SHARE_RUNNER_UNSUPPORTED`: the runner offers no shares this telo can use. Either it offers none at all, or it speaks no tunnel generation this telo offers.
  - `ERR_SHARE_APP_UNSUPPORTED`: no `tcp` port, or `Telo.DesktopHost` declared.
  - `ERR_SHARE_HOST_VALUE_CONFLICT`: a public-URL host template is set beside `--share`.
  - `ERR_SHARE_LOST`: the share was deleted or taken over while running.
- `/v1` contract:
  - `features.shares` in `/v1/capabilities`, holding `{ maxPerOwner, retentionSeconds }`.
  - `POST /v1/shares`: get or create by `name`. It answers `{ id, name, application, publicUrlTemplate, publicUrlSecondaryTemplate, tunnelUrl }`, `201` when new and `200` when it exists.
  - `GET /v1/shares`: the caller's shares, each `{ id, name, application, connected, lastActiveAt }`, newest activity first.
  - `DELETE /v1/shares/{id}`: `204`, or `404 share_not_found` for an unknown, deleted or foreign id.
  - `429 too_many_shares`.
- Visitor answers from the relay:
  - `503` with `Retry-After` for any well-formed host whose id has no live tunnel;
  - `404` for a host that does not parse, or a port the tunnel did not announce;
  - `502` / `504` when the local port refuses or is slow.
- `/v1/shares/{id}/tunnel` on `tunnel.<baseDomain>`: the tunnel endpoint, served by the relay. It is a WebSocket with subprotocol `telo-share-1`.
  - Close codes: `4400` protocol error, `4401` credential refused, `4404` share deleted, `4408` keepalive timeout, `4409` superseded by another run, `4503` runner at its connected-share capacity.
  - Inside it: the relay-set request header `telo-share-port`, and the CLI's control message `ports`.
- `packages/share-tunnel` (`@telorun/share-tunnel`): a new release unit, off the telo line, under the Sustainable Use license. It holds the tunnel protocol spec `specs/tunnel-protocol.md` (generation 1, with vectors) and both engines, the relay end and the client end.
- Runner settings: `RUNNER_SHARES`, `RUNNER_ROLE` (`control` by default, or `relay`), `RUNNER_MAX_CONNECTED_SHARES`, `RUNNER_MAX_SHARES_PER_OWNER`, `RUNNER_SHARE_RETENTION_SECONDS`.
- k8s-runner chart:
  - A `shares` values block with `enabled`, `maxConnected`, `maxPerOwner` and `retentionSeconds`.
  - A `<release>-relay` Deployment (one replica, `Recreate`) and Service.
  - One wildcard route `*.<sessionRouting.baseDomain>` to the relay, rendered for the chosen layer.
- Runner boot refusals, by both the runner and the chart, of `RUNNER_SHARES` or `RUNNER_ROLE=relay`:
  - with a SQLite store;
  - without identity;
  - under routing mode `auto` or `none`;
  - over a backend that routes no shares.
- Store: a `runner_shares` table (Postgres) holding each share's `epoch`, `connectedAt` and `disconnectedAt`. The store's schema version moves.

**Changed**
- Session routing: under a share-enabled k8s runner, a `*.<baseDomain>` host that no session routes (a suspended session's included) reaches the relay, which answers it as a share with no tunnel, `503`, instead of the edge's default answer.
- Identity contract (runner-core § Identity): a DPoP proof's `htu` must equal the URL the request was sent to, as the route supplies it, not always the audience plus the path. The token's `aud` must still contain `RUNNER_IDENTITY_AUDIENCE`.

**Removed**
- None.

## Solution

**Before:** `telo run ./webhook-demo` serves `http://localhost:8080`. The app's `Telo.PublicUrl` is whatever the env supplies.

**After:** `telo run --share ./webhook-demo` takes a share `k3xqz2m7ahc4` for the signed-in user. Share ids are drawn as session ids are, twelve characters of `[a-z2-7]`. Every `tcp` port is then reachable at `https://<port>-k3xqz2m7ahc4.telorun.dev`, and the local kernel derives every `Telo.PublicUrl` from the share. WebSockets and streamed bodies work. Running the same command tomorrow gets the same addresses.

### The application

The application needs nothing in its manifest to be shareable. This app has two HTTP ports, one `Telo.PublicUrl` need and one `udp` port:

```yaml
kind: Telo.Application
metadata: { name: WebhookDemo }
imports:
  Http: oci://ghcr.io/telorun/http-server@0.44.2
ports:
  http: { env: PORT, default: 8080 }
  admin: { env: ADMIN_PORT, default: 9090 }
  stats: { env: STATS_PORT, protocol: udp, default: 8125 }
needs:
  site: { kind: Telo.PublicUrl, parameters: { port: http } }
targets: [!ref server, !ref adminServer]
---
kind: Http.Server
metadata: { name: server }
listen: { port: !cel "ports.http" }
trustProxy: true
mounts: [{ path: /, mount: !ref hooks }]
---
kind: Http.Api
metadata: { name: hooks }
routes:
  - request: { path: /hooks/github, method: POST }
    returns:
      - status: 202
        content:
          application/json:
            body:
              callback: !interpolate "${{ resources.site.url }}/oauth/callback"
---
kind: Http.Server
metadata: { name: adminServer }
listen: { port: !cel "ports.admin" }
mounts: [{ path: /, mount: !ref status }]
---
kind: Http.Api
metadata: { name: status }
routes:
  - request: { path: /health, method: GET }
    returns:
      - status: 200
        content: { application/json: { body: { ok: true } } }
```

### Using it

Sign-in is a prerequisite: `telo auth login` is the runner sign-in plan's. Everything the CLI prints here goes to stderr.

```console
$ telo run --share ./webhook-demo
error ERR_RUNNER_SIGN_IN_REQUIRED: sharing needs a sign-in to https://runner.telo.run
  run: telo auth login --runner https://runner.telo.run

$ telo auth login --runner https://runner.telo.run
Signed in to https://runner.telo.run as octo@example.org

$ telo run --share ./webhook-demo
Shared through https://runner.telo.run (share k3xqz2m7ahc4):
  http   8080      https://8080-k3xqz2m7ahc4.telorun.dev   site
  admin  9090      https://9090-k3xqz2m7ahc4.telorun.dev
  stats  8125/udp  not shared: udp
```

Second terminal, the same directory. This run takes the share over, and the first run exits:

```console
$ telo run --share ./webhook-demo
Shared through https://runner.telo.run (share k3xqz2m7ahc4):
  http   8080      https://8080-k3xqz2m7ahc4.telorun.dev   site
  admin  9090      https://9090-k3xqz2m7ahc4.telorun.dev
  stats  8125/udp  not shared: udp
```

```console
error ERR_SHARE_LOST: share k3xqz2m7ahc4 was taken over by another run
$ echo $?
1
```

A named share, the same on every machine signed in as the same user. Shares on another runner:

```console
$ telo run --share=demo ./webhook-demo
Shared through https://runner.telo.run (share p7d2wqe4r6tb):
  http   8080      https://8080-p7d2wqe4r6tb.telorun.dev   site
  admin  9090      https://9090-p7d2wqe4r6tb.telorun.dev
  stats  8125/udp  not shared: udp

$ telo shares list
ID            NAME                                   APPLICATION  CONNECTED  LAST ACTIVE
p7d2wqe4r6tb  demo                                   WebhookDemo  yes        2026-11-13T10:42:07Z
k3xqz2m7ahc4  6f1c2a9e-4b7d-4e0a-9c3f-2d8e5b1a7c40   WebhookDemo  no         2026-11-13T10:41:15Z

$ telo shares delete k3xqz2m7ahc4
Deleted share k3xqz2m7ahc4

$ telo run --share --share-runner https://runner.acme.internal ./webhook-demo
error ERR_SHARE_RUNNER_UNSUPPORTED: https://runner.acme.internal offers no shares

$ telo shares list --runner https://runner.acme.internal
error ERR_SHARE_RUNNER_UNSUPPORTED: https://runner.acme.internal offers no shares
```

Under `--watch`, a port added to the manifest is announced without reconnecting:

```console
$ telo run --watch --share ./webhook-demo
Shared through https://runner.telo.run (share k3xqz2m7ahc4):
  http   8080      https://8080-k3xqz2m7ahc4.telorun.dev   site
  admin  9090      https://9090-k3xqz2m7ahc4.telorun.dev
  stats  8125/udp  not shared: udp
Reloaded: now also sharing
  metrics  9100    https://9100-k3xqz2m7ahc4.telorun.dev
```

A grant that expires mid-run, or a runner at capacity, warns once and the run keeps going:

```console
warning: https://runner.telo.run refused the share's credential; visitors get 503 until you run:
  telo auth login --runner https://runner.telo.run
Share k3xqz2m7ahc4 reconnected.
warning: https://runner.telo.run is at its connected-share capacity; retrying (visitors get 503 meanwhile)
Share k3xqz2m7ahc4 reconnected.
```

Refused before boot:

```console
$ telo run --share-runner https://runner.acme.internal ./webhook-demo
error: --share-runner needs --share

$ TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE=https://{label}.dev.acme.test telo run --share ./webhook-demo
error ERR_SHARE_HOST_VALUE_CONFLICT: TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE is set; --share is the host of this run's public addresses

$ telo run --share ./desktop-notes
error ERR_SHARE_APP_UNSUPPORTED: DesktopNotes declares Telo.DesktopHost, whose window admission answers every visitor 403

$ telo run --share ./cli-tool
error ERR_SHARE_APP_UNSUPPORTED: CliTool declares no tcp port
```

### Taking the share

The CLI does this before the kernel is built.

1. It reads the runner's `/v1/capabilities`. It needs two members: `features.shares` must be present, and the sign-in's `identity.resource` check (the sign-in plan's) must pass.

   ```json
   {
     "features": { "shares": { "maxPerOwner": 10, "retentionSeconds": 604800 } },
     "identity": {
       "resource": "https://runner.telo.run",
       "authorization_servers": ["https://accounts.telo.run"],
       "dpop_bound_access_tokens_required": true,
       "dpop_signing_alg_values_supported": ["ES256", "EdDSA"]
     }
   }
   ```

2. It posts the share:
   - `name` is the `--share=<name>` value when one is given. Otherwise it is a UUID minted once per real manifest path and kept in `share-names.json`. So a copy of a starter in another directory gets its own origin, with its own cookies, and no home-directory path goes on the wire.
   - `application` is the root's `metadata.name`, for display only.

   ```http
   POST /v1/shares HTTP/1.1
   Host: runner.telo.run
   Authorization: DPoP <access token>
   DPoP: <proof>
   Content-Type: application/json

   { "name": "6f1c2a9e-4b7d-4e0a-9c3f-2d8e5b1a7c40", "application": "WebhookDemo" }
   ```

   ```http
   HTTP/1.1 201 Created
   Content-Type: application/json

   {
     "id": "k3xqz2m7ahc4",
     "name": "6f1c2a9e-4b7d-4e0a-9c3f-2d8e5b1a7c40",
     "application": "WebhookDemo",
     "publicUrlTemplate": "https://{port}-k3xqz2m7ahc4.telorun.dev",
     "publicUrlSecondaryTemplate": "https://{label}--{port}-k3xqz2m7ahc4.telorun.dev",
     "tunnelUrl": "wss://tunnel.telorun.dev/v1/shares/k3xqz2m7ahc4/tunnel"
   }
   ```

   The same body later answers `200` with the same object. An owner already at `maxPerOwner` gets `429 too_many_shares`, and a resume-secret caller gets the existing `403 identity_required`:

   ```http
   HTTP/1.1 429 Too Many Requests
   Content-Type: application/json

   { "error": "too_many_shares", "message": "this runner keeps at most 10 shares per owner; delete one with telo shares delete <id>" }
   ```

`GET /v1/shares` answers the list `telo shares list` prints:

```http
GET /v1/shares HTTP/1.1
Host: runner.telo.run
Authorization: DPoP <access token>
DPoP: <proof>
```

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "shares": [
    { "id": "p7d2wqe4r6tb", "name": "demo", "application": "WebhookDemo", "connected": true, "lastActiveAt": "2026-11-13T10:42:07Z" },
    { "id": "k3xqz2m7ahc4", "name": "6f1c2a9e-4b7d-4e0a-9c3f-2d8e5b1a7c40", "application": "WebhookDemo", "connected": false, "lastActiveAt": "2026-11-13T10:41:15Z" }
  ]
}
```

`DELETE /v1/shares/{id}` answers `204`. Another owner's id answers the same `404` as an unknown one:

```http
DELETE /v1/shares/k3xqz2m7ahc4 HTTP/1.1
Host: runner.telo.run
Authorization: DPoP <access token>
DPoP: <proof>
```

```http
HTTP/1.1 204 No Content
```

The same request for an id that is unknown, already deleted, or another owner's:

```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{ "error": "share_not_found", "message": "no share k3xqz2m7ahc4" }
```

`lastActiveAt` is the latest of the share's creation, last connect and last disconnect. A share is its owner's until it is deleted, or, while not connected, until `lastActiveAt + retentionSeconds`. A connected share never expires. A share is not a session: it has no workspace, no workload and no events.

### Being the host

The CLI hands the share's two templates to the kernel, verbatim, as `TELO_HOST_PUBLIC_URL_TEMPLATE` / `_SECONDARY_TEMPLATE`. It composes no hostname itself, so the runner stays the one authority on its naming.

Each port's hosts follow the rule sessions already use:
- every declared `tcp` port gets its own `<port>-<id>` host;
- every need host the kernel derives for that port is added;
- a `udp` port is listed as not shared;
- a port that does not speak HTTP answers visitors `502`, as on a session.

A `Telo.PublicUrl` whose `TELO_NEED_…__URL` the environment sets keeps that value, and is listed as not shared, because whoever set it is its host. Like a session, a share is a partial host: a `Telo.PublicHostPattern` need, or a `customDomains` one, still comes from the environment, and without it the load fails `ERR_NEED_UNMET` naming the variable.

```console
$ TELO_NEED_SITE__URL=https://hooks.acme.test telo run --share ./webhook-demo
Shared through https://runner.telo.run (share k3xqz2m7ahc4):
  http   8080      https://8080-k3xqz2m7ahc4.telorun.dev
  admin  9090      https://9090-k3xqz2m7ahc4.telorun.dev
  stats  8125/udp  not shared: udp
  site             https://hooks.acme.test   not shared: set by TELO_NEED_SITE__URL
```

### The tunnel

The CLI opens one WebSocket to `tunnelUrl` once the share is taken; boot does not wait for it to connect. The upgrade carries `Authorization: DPoP` and a proof with `htm` `GET` and `htu` the `https://` form of `tunnelUrl`. The relay verifies both through runner-core's identity verifier. It passes the URL it was reached at, which it derives from the base domain it already holds. The token's `aud` must still contain the runner's audience: the relay is the same resource server at another host.

Inside the WebSocket runs one HTTP/2 connection, with the relay acting as client:
- **Requests.** Each visitor request is a stream. It carries the original `Host` as `:authority`, and the target port in a `telo-share-port` header. The relay overwrites any `telo-share-port` a visitor sent. The CLI refuses a stream for a port missing from its last `ports` message, and strips the header before forwarding locally.
- **Local target.** The CLI forwards each stream to `127.0.0.1` on the target port.
- **Visitor WebSockets** arrive as RFC 8441 extended CONNECT streams. The CLI turns each into an HTTP/1.1 upgrade on the local port.
- **Backpressure** and streamed bodies are HTTP/2 flow control, so relay memory stays bounded at any body size.

Why this design:
- WebSocket over 443 is what corporate proxies pass.
- HTTP/2 is a published multiplexer with flow control and extended CONNECT, implemented in both Node and Rust. With framing of our own, every client would have to re-specify flow control.
- RFC 8441 straight to the edge does not pass common Ingress controllers, and QUIC is blocked on the networks developers share from.

On every load, the CLI sends one JSON control message listing the `tcp` ports `Kernel.PortsResolved` announced. The relay routes every host that parses as `[<label>--]<port>-<id>` for this share, when its port is in the list. Every need host the templates derive has that form, and the app's own `hostnames` routing decides what each host gets:

```json
{
  "type": "ports",
  "ports": [
    { "name": "http", "port": 8080 },
    { "name": "admin", "port": 9090 }
  ]
}
```

The tunnel belongs to the `telo run` invocation, so it survives every `--watch` reload.
- **Reconnects.** It reconnects with capped backoff through every close except those that end the run (below), re-reading the sign-in's credentials on each attempt. It warns once per distinct close reason, carrying the relay's close text. On `4401` the warning names the `telo auth login --runner <url>` to run; on `4503` it says the runner is at capacity.
- **Fence.** Each run's first connect increments the share's `epoch`; a reconnect presents the epoch it holds. A second run of the same share therefore takes over: the first run drains under GOAWAY and is closed `4409`, and its later reconnects are closed `4409` too.
- **Lost.** `4404` and `4409` end the run non-zero with `ERR_SHARE_LOST`, naming the reason. The app's public addresses no longer reach this process and cannot again.
- **Mismatch.** Two cases end the run non-zero with `ERR_SHARE_RUNNER_UNSUPPORTED`, naming the generations this telo offered: an upgrade where the relay selects none of the offered subprotocols, and a close `4400`. Retrying cannot change either answer. The spec states that both are terminal.

```console
error ERR_SHARE_RUNNER_UNSUPPORTED: https://runner.telo.run speaks no tunnel generation this telo offers (telo-share-1)
```

### The runner

The shares live in three places:

| Part | Where | What it does |
|---|---|---|
| Control plane | runner-core | Serves `/v1/shares` over its store and caller resolver. |
| Tunnel package | `@telorun/share-tunnel` | Holds the protocol and both engines. Depends on nothing in runner-core, and declares two seams: a share directory (look up, connect with fence, record a disconnect) and a tunnel authenticator. |
| Relay | runner-core, as role `relay` | Implements the two seams with its store and identity verifier. Only the CLI uses the client engine. |

`RUNNER_ROLE=relay` starts the same runner image as the relay. The k8s runner runs it as a separate `relay` Deployment, with one replica hard-coded and the `Recreate` strategy, as the control plane has. Visitor traffic therefore never passes through the control plane, which is pinned to one replica and manages every session. A relay rollout drops every tunnel, and each CLI's reconnect restores it.

**Who owns which state.** The relay owns connection state:
- It writes each share's `connectedAt` and `disconnectedAt` to the store; `GET /v1/shares` derives `connected` from them.
- At boot it marks every connected share disconnected, since it holds no tunnel at that moment.
- Every 5 s it reads which of the shares it holds tunnels for were deleted, and closes each one's tunnel `4404`. A delete therefore reaches visitors and the run within 5 s.
- It answers visitors from the tunnels it holds alone, never reading the store per request.

The control plane owns `/v1/shares` and the retention sweep.

**Routing.** The chart renders one route, `*.<sessionRouting.baseDomain>`, to the relay Service, in the runner's namespace, for the layer `sessionRouting.mode` names (`ingress` or `gateway`):
- Exact per-session hosts outrank the wildcard, so sessions keep their own hosts.
- The relay serves the tunnel endpoint at `tunnel.<baseDomain>`. Every other host it parses as `[<label>--]<port>-<id>`, right-anchored.
- The relay forwards the edge's `X-Forwarded-*` headers unchanged. An app therefore sees the same request whether a session or a share hosts it.

**Configuration**

| Setting | Meaning | Default |
|---|---|---|
| `RUNNER_SHARES` | Offer shares (`features.shares`). | off |
| `RUNNER_ROLE` | `control` serves `/v1`; `relay` serves tunnels and visitors. | `control` |
| `RUNNER_MAX_CONNECTED_SHARES` | Tunnels connected at once, runner-wide. Beyond it, close `4503`, and the CLI keeps retrying. | `200` |
| `RUNNER_MAX_SHARES_PER_OWNER` | Shares one owner keeps. Beyond it, `429 too_many_shares`. | `10` |
| `RUNNER_SHARE_RETENTION_SECONDS` | How long after the later of its creation and its last disconnect a share is deleted. A connected share is never deleted. | `604800` |

`RUNNER_SHARES` and `RUNNER_ROLE=relay` refuse to boot in any of these cases, each naming the setting to fix:
- with `RUNNER_SESSION_STORE=sqlite`, because the relay is another process and a SQLite file belongs to one pod;
- without `RUNNER_IDENTITY_AUDIENCE` / `RUNNER_IDENTITY_ISSUERS`;
- over a backend that does not route shares. Docker and `telo runner` never do. k8s does only with `SESSION_ROUTING_MODE` set to `ingress` or `gateway` and a base domain.

The chart's value validation refuses the same combinations. For example:

```console
$ RUNNER_SHARES=1 RUNNER_SESSION_STORE=sqlite k8s-runner
error: RUNNER_SHARES needs RUNNER_SESSION_STORE=postgres: the relay is a separate process and cannot read a SQLite file

$ helm install runner ./chart --set shares.enabled=true --set sessionRouting.mode=auto
Error: execution error at (k8s-runner/templates/validate-values.yaml): shares.enabled needs sessionRouting.mode ingress or gateway, not auto
```

Chart values for the hosted runner:

```yaml
sessionStore:
  kind: postgres
  existingSecret: runner-store
  existingSecretKey: url
identity:
  audience: https://runner.telo.run
  issuers: [https://accounts.telo.run]
sessionRouting:
  mode: gateway
  baseDomain: telorun.dev
shares:
  enabled: true
  maxConnected: 200
  maxPerOwner: 10
  retentionSeconds: 604800
```

**What a visitor gets** when the share cannot answer:
- `503` with `Retry-After` for any well-formed host whose id has no live tunnel, whether the share exists, was deleted or never existed;
- `404` for a host that does not parse, or a port the connected tunnel did not announce;
- `502` or `504` when the local port refuses the connection or is slow.

```http
HTTP/1.1 503 Service Unavailable
Retry-After: 5
Content-Type: text/plain

This share is not connected.
```

### Rust

The Rust CLI does not offer `--share`. The tunnel protocol is specified so that it can, and both engines in `@telorun/share-tunnel` run the spec's vectors.

### Docs and bookkeeping

- **Guides:**
  - a guide to sharing a local run;
  - a section in the providing-needs guide on `telo run --share` as a host;
  - in runner-core's README, § Identity states the `htu` rule per route, § Public addresses names the CLI share as a template-mode host, and a new § Shares covers the routes, the settings and the retention clock;
  - the k8s runner README covers the relay Deployment, the wildcard route, the TLS secret in the runner's namespace, and a Gateway listener admitting that namespace;
  - the CLI guide covers `telo shares`.
- **Agent and ledger:** a paragraph in the authoring-agent primer, and a benefits-ledger entry under Telo itself ("Share a local run").
- **Release:**
  - add `packages/share-tunnel` to `release.units`;
  - add `telo release add` fragments for `cli`, `packages/runner-core`, `packages/share-tunnel` and `apps/k8s-runner`.

## Verify

1. **Happy path.** Run `telo run --share` on the example app and open the printed addresses from another network:
   - `8080-…` loads;
   - `/hooks/github` answers a `callback` starting with that address;
   - `9090-…/health` answers.
   An app serving a WebSocket echo answers through its share as it does locally.
2. **Stable addresses.**
   - Running again from the same directory returns the same id.
   - A copy in another directory gets a different id.
   - `--share=demo` gives the same id on a second machine signed in as the same user.
3. **Watch.** Under `--watch`:
   - adding a port makes its host reachable without reconnecting;
   - a visitor WebSocket survives a reload of another port.
4. **Takeover.** Start run 1, then run 2 on the same share. Run 1 exits with `ERR_SHARE_LOST`, and run 2 keeps serving. Repeat with run 1's network dropped across the takeover: its reconnect gets `4409` and it exits.
5. **Ending a share.**
   - Stopping the CLI makes visitors get `503` with `Retry-After`.
   - `telo shares delete <id>` ends a connected run with `ERR_SHARE_LOST` within 5 s. Visitors then get the same `503` as for a random id.
   - A share created and never connected is deleted `retentionSeconds` after its creation.
6. **Expired grant.** An expired grant leaves the app running with the warning. `telo auth login --runner <url>` in another terminal resumes the same addresses.
7. **Relay rollout.**
   - Restarting the control-plane Deployment drops no connected tunnel.
   - Restarting the relay gives visitors `503` until the CLI reconnects.
   - After the relay is killed with `SIGKILL` and restarts, `telo shares list` shows every share not connected before any CLI reconnects.
8. **Routing precedence.** Under both Ingress and Gateway mode, with the wildcard live, a session host still reaches its session.
9. **Header handling.**
   - A visitor-sent `telo-share-port` naming an undeclared port reaches nothing on the developer's machine.
   - An app echoing its request headers shows the original `Host` and the edge's `X-Forwarded-*`, the same as under a session.
10. **Bounded memory and load.**
    - A 1 GiB upload through a slow local app keeps relay memory bounded.
    - A flood of requests for random well-formed ids makes no store read.
11. **Tunnel authentication and generations.**
    - A tunnel proof whose `htu` names `runner.telo.run` is refused at the relay with `4401`. A proof for the tunnel URL is refused on `/v1`.
    - A replayed tunnel proof is refused across a relay restart.
    - A relay speaking only a later generation, or closing `4400`, ends the run with `ERR_SHARE_RUNNER_UNSUPPORTED` after one connect attempt, with no reconnect.
12. **Limits.**
    - An owner's 11th share gets `429 too_many_shares`.
    - Of two copies of one app, the one run last lists first in `telo shares list`.
    - With `RUNNER_MAX_CONNECTED_SHARES=1`, a second tunnel is closed `4503`, warns once, and connects once the first leaves.
13. **CLI refusals before boot.** `--share` refuses with the code named above in each case:
    - pointed at a docker runner;
    - on a root declaring `Telo.DesktopHost`;
    - on a root with no `tcp` port;
    - with either `TELO_HOST_PUBLIC_URL_TEMPLATE` or `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE` set;
    - when not signed in;
    - `--share-runner` without `--share`.
14. **Runner refusals at boot.** The runner and the chart each refuse `RUNNER_SHARES`:
    - on SQLite;
    - without identity;
    - under routing mode `auto` or `none`;
    - on the docker runner and `telo runner`.
