---
status: draft
priority: medium
depends-on: []
packages: [cli/nodejs, packages/runner-core, packages/share-relay, apps/k8s-runner]
refinement: not-started
---

# Sharing a local run

## Problem

An application run with `telo run` is reachable only from the machine running it. To show it to someone, test a webhook, or try an OAuth callback against a real HTTPS origin, the developer needs a third-party tunnel. It hands them a URL Telo knows nothing about, so the app's `Telo.PublicUrl` need still resolves to whatever the env says. Links, redirects and callbacks the app builds point at `localhost` unless the developer copies the tunnel's address into `TELO_NEED_…__URL` by hand, and copies it again each time the tunnel gives a new one.

The hosted runner (`https://runner.telo.run`) already routes `<port>-<id>.telorun.dev` to session workloads and is a template-mode host of `Telo.PublicUrl`. A local run cannot use any of it.

## Surface

**Added**
- `telo run --share[=<name>]`: exposes the root Application's `tcp` ports publicly through the runner. `<name>` names the reservation; without it the reservation is per manifest copy.
- `telo run --runner <url>`: the runner a share goes to. Legal only beside `--share`.
- `telo auth login [--runner <url>] [--device]`, `telo auth logout`, `telo auth status`: sign-in to a runner through accounts.
- `telo shares list`, `telo shares release <id>`: list and release the signed-in user's reservations.
- `TELO_RUNNER_URL`: the default runner for `--share` and `telo auth`. Without it, `https://runner.telo.run`.
- `TELO_ACCOUNTS_URL`: the identity provider. Without it, `https://accounts.telo.run`.
- `<per-user state>/telo/auth/credentials.json` (+ `credentials.lock`): refresh tokens per runner and the installation's DPoP key, `0600` in a `0700` directory.
- `<per-user state>/telo/shares.json`: the minted reservation name per manifest path.
- CLI refusals: `ERR_SHARE_SIGN_IN_REQUIRED`, `ERR_SHARE_UNAVAILABLE`, `ERR_SHARE_UNSUPPORTED`, `ERR_SHARE_HOST_VALUE_CONFLICT`, `ERR_SHARE_LOST`.
- `/v1` contract: `features.shares` (presence gates; carries the operator's limits); `POST /v1/shares` (get-or-create by `name`, answering `{ id, name, application, publicUrlTemplate, publicUrlSecondaryTemplate, tunnelUrl }`, `201` new / `200` existing); `GET /v1/shares`; `DELETE /v1/shares/{id}`; `403 identity_required` for a resume-secret caller; `429 share_limit_reached`.
- `/v1/share-tunnels/{id}`: the tunnel endpoint, a WebSocket with subprotocol `telo-share-1`, close codes `4400` / `4401` / `4404` / `4408` / `4409` / `4429`.
- `packages/share-relay/specs/share-tunnel-protocol.md`: the normative tunnel protocol, generation 1, with vectors.
- Runner settings: `RUNNER_SHARES_ENABLED`, `RUNNER_ROLE` (`control` default | `relay`), `RUNNER_SHARE_MAX_RESERVATIONS`, `RUNNER_SHARE_MAX_CONNECTED`, `RUNNER_SHARE_RESERVATION_IDLE_SECONDS`, `RUNNER_SHARE_MAX_REQUEST_BYTES`, `RUNNER_SHARE_BANDWIDTH_BYTES_PER_SECOND`.
- k8s-runner chart: a `shares` values block (enabled, relay replicas, limits) rendering a `relay` Deployment and those variables.
- Store: an id registry table holding every hostname id (`address_ids`; `runner_address_ids` on Postgres) and a share table with lease columns. The store's schema version moves.

**Changed**
- Session creation registers its id in the id registry, so a session id and a share id can never coincide.

**Removed**
- None.

## Solution

**Before:** `telo run ./app` serves `http://localhost:8080`, and the app's `Telo.PublicUrl` is whatever the env supplies. **After:** `telo run --share ./app` reserves `https://8080-k3x9…​.telorun.dev` for the signed-in user. The local kernel derives every `Telo.PublicUrl` from that address, and a visitor anywhere reaches the local process over HTTPS. WebSockets and streamed bodies work. The same command tomorrow gets the same address.

**Signing in.** `telo auth login` takes a grant per runner from accounts, under the runner resource class accounts' runner-tokens plan defines: `resource=<runner URL>`, scope `runner:sessions`, client `telo-cli`. The default is the browser over a loopback redirect with PKCE; `--device` uses the device authorization flow for SSH and headless machines. Every token is DPoP-bound to one ES256 key per subject per installation. Refresh tokens and the key live in the credentials file. Every refresh runs under its lock and re-reads the file after taking it, so concurrent `telo` processes never lose a rotated refresh token. Access tokens stay in memory. `telo auth logout` revokes each grant at the issuer (a failed revocation is reported) and deletes the file. `telo auth status` lists the signed-in subject and the runners it holds grants for.

**Reserving.** Before the kernel is built, `telo run --share` reads the runner's `/v1/capabilities`. It refuses unless all three hold: `features.shares` is present, `identity.resource` equals the runner URL as text, and the CLI's issuer is in `authorization_servers`. It then posts the reservation:
- `name` is `--share=<name>` if given, else a `device:<uuid>` minted once per real manifest path and kept in `shares.json`.
- `application` is the root's `metadata.name`, for display only.

The reservation is the owner's until released with `telo shares release`, or until the operator's idle period passes after its last disconnect. An identity owns it; a resume secret never does.

**Being the host.** The CLI sets the reservation's two templates as the kernel's `TELO_HOST_PUBLIC_URL_TEMPLATE` / `_SECONDARY_TEMPLATE`, verbatim. It composes no hostname of its own, so the runner stays the one authority on its naming. Every `tcp` port is shared, and a `udp` port is listed on stderr as not shared. A `Telo.PublicUrl` whose `TELO_NEED_…__URL` the environment sets keeps that value and is reported as not shared: whoever set it is its host.

**The tunnel.** The CLI opens one WebSocket to the reservation's `tunnelUrl`, which must be on the runner's origin. It authenticates with `Authorization: DPoP` and a proof, the same identity branch every runner route uses. Inside the WebSocket runs one HTTP/2 connection, with the relay as client:
- **Requests.** Each visitor request is a stream: the original `Host` is carried as `:authority`, and the target port is in a relay-set `telo-share-port` header.
- **Visitor WebSockets** arrive as RFC 8441 extended CONNECT streams; the CLI turns each into an HTTP/1.1 upgrade on the local port.
- **Backpressure** and streaming bodies are HTTP/2 flow control.

Two JSON control messages flow from the CLI. `ports` is sent on every load, carrying what `Kernel.PortsResolved` announced; the relay routes only those hosts. `credential` carries a renewed token and proof, so a long-lived tunnel outlives its tokens.

The tunnel belongs to the `telo run` invocation, so it survives every `--watch` reload. It reconnects with backoff through every close except `4401`, `4404` and `4409`. A second run of the same share takes over: the first drains under GOAWAY and then closes `4409`. A tunnel ending for good stops the run, exiting non-zero with `ERR_SHARE_LOST` naming the reason, because the app's public addresses would otherwise point at nothing.

**The runner.** runner-core serves the reservation routes over its existing store and caller resolver. A share is not a session: it has no workspace, no workload and no events. The relay engine lives in its own package, `packages/share-relay`, beside the protocol spec and a client engine the CLI uses. The k8s runner runs that engine as a separate `relay` Deployment from its own image (`RUNNER_ROLE=relay`), so a control-plane rollout drops no tunnel and visitor traffic scales on its own.

When there are several replicas, a lease in the store names the replica holding each tunnel, with a fencing generation. A visitor request landing on another replica is forwarded to the holder in one internal hop, on a port only relay pods reach.

At boot the runner publishes one `*.<baseDomain>` route to the relay through its routing seam, under whichever layer the routing mode resolved. The route sits beneath the exact per-session hosts, and `/v1/share-tunnels/` on the runner's origin also routes to the relay. The relay parses `[<label>--]<port>-<id>` from `Host`, right-anchored, and forwards the edge's `X-Forwarded-*` headers unchanged. So an app sees the same request whether a session or a share hosts it. Shares are offered only when `RUNNER_SHARES_ENABLED` is set; boot refuses that setting under routing mode `none` or with no base domain. The docker runner and `telo runner` never advertise shares.

**What a visitor gets** when the share cannot answer:
- `503` with `Retry-After` while the reservation exists but no tunnel is connected.
- `404` for an unknown or released id, or for a host the tunnel did not announce.
- `502` or `504` when the local port refuses or is slow.
- `413` over the request bound.

**Refused before boot:**
- `ERR_SHARE_SIGN_IN_REQUIRED`: no grant for the runner. It names the `telo auth login --runner <url>` to run.
- `ERR_SHARE_UNAVAILABLE`: the runner offers no shares or fails the identity check.
- `ERR_SHARE_UNSUPPORTED`: the root has no `tcp` port, or declares `Telo.DesktopHost`, whose loopback admission would answer every visitor `403`.
- `ERR_SHARE_HOST_VALUE_CONFLICT`: an environment sets either public-URL host template beside `--share`.

**Rust.** The Rust CLI does not offer `--share`. The tunnel protocol and the credentials file format are specified so that it can, and the spec's vectors are run by both Node halves.

**Docs and bookkeeping:**
- **Guides:** a guide to sharing a local run; a section in the providing-needs guide on `telo run --share` as a host; runner-core's README § Public addresses names the CLI share as a template-mode host; the k8s runner README covers the relay and the wildcard route; the CLI guide covers `telo auth` and `telo shares`.
- **Agent and ledger:** a paragraph in the authoring-agent primer, and a benefits-ledger entry under Telo itself ("Share a local run").
- **Changesets:** for the CLI, runner-core, `@telorun/share-relay` and the k8s runner.

## Decisions

- **Sign-in required.** An anonymous relay on the runner's domain would get the domain blocklisted for phishing, taking every runner session down with it, with no owner to ban.
- **Reservations are keyed by owner and an opaque `name`, defaulting to one per manifest copy.** An origin is the web's security boundary, and keying by `metadata.name` would hand one origin, with its cookies and stored data, to every copy of a starter. Sending the manifest path would put a home-directory path on the wire.
- **The control plane is in runner-core and the data plane in its own package and Deployment.** Running the relay in the runner's process drops every tunnel on each rollout. A separate app would be a second owner of the id namespace, with a second identity verifier.
- **One id registry for sessions and shares.** It turns "no host names two things" from 60-bit chance into a store constraint.
- **One wildcard route and Host parsing, not routing objects per share.** Routing cost stays constant, and a share has no pod to own cluster objects.
- **Reverse HTTP/2 inside one WebSocket over 443.** WebSocket is what corporate proxies pass, and HTTP/2 is a published multiplexer with flow control and extended CONNECT that Node and Rust both implement. Our own framing would make every client re-specify flow control. RFC 8441 to the edge doesn't pass common Ingress controllers, and QUIC is blocked on the networks developers share from.
- **The reservation hands over its templates and tunnel URL, and the CLI composes nothing.** A base domain the CLI builds hosts from would copy the runner's host grammar into every released client.
- **Credentials live in a `0600` file, not the OS keychain.** The single-file executable cannot carry a native library, and headless Linux has no secret service. A file is also the one store the Rust twin can read.
- **Loopback sign-in by default, device code on request.** The device code flow is phishable, and this grant exposes services publicly. It is opt-in for SSH and headless machines, never inferred.
- **An env-supplied address wins over the share, and a conflicting host template is refused.** The share hosts exactly what `--share` names, and nothing someone else named.
- **`telo auth …` as a group.** Three verbs plus per-runner status read as one group, as in `gh auth` and `gcloud auth`.

## Verify

- Run `telo run --share` on an app with an `Http.Server` and a `Telo.PublicUrl` need, open the printed address from another network, and check three things: the page loads; the app's own `resources.<need>.url` equals that address; a WebSocket route echoes.
- Run it again from the same directory: the same id comes back. A copy of the app in another directory gets a different id. `--share=demo` gives the same id on a second machine signed in as the same user.
- Under `--watch`, adding a port makes its host reachable without reconnecting, and a visitor WebSocket survives a reload of another port.
- Stopping the CLI makes visitors get `503` with `Retry-After`. `telo shares release <id>` makes them get `404`.
- A share id equal to a live session id is refused by the store, on both SQLite and Postgres. With a live session and a live share on the same port number, each host reaches its own target, under both Ingress and Gateway mode.
- Restarting the control-plane Deployment drops no connected tunnel. With three relay replicas, a request landing on a non-holder succeeds. Killing the holder lets the CLI's reconnect take the lease elsewhere.
- A 1 GiB upload through a slow local app keeps relay memory bounded. A visitor WebSocket outlives three access-token renewals.
- Two concurrent `telo run --share` processes started past a token's expiry both connect, and the credentials file still holds a working refresh token. `telo auth login --device` completes over SSH. `telo auth logout` leaves no file.
- `--share` refuses before boot in each of these cases, with the code named above: pointed at a docker runner; on a root declaring `Telo.DesktopHost`; with `TELO_HOST_PUBLIC_URL_TEMPLATE` set; when not signed in.
- An app echoing its request headers shows the original `Host` and the edge's `X-Forwarded-*`, the same as when a runner session hosts it.
