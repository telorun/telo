# OAuth client module

## Problem

Nothing in the standard library or the hub can obtain user consent. The only OAuth code that
exists is `RefreshAccessToken` buried inside the `google/sheets` connector, which assumes a
refresh token already exists and says nothing about how it was acquired. Every connector that
needs delegated access therefore either re-implements the flow or pushes it onto the user as a
"paste a refresh token into an env var" step done outside Telo. The missing primitive is the
interactive part: driving a user through consent from a terminal, exchanging the resulting code
for tokens, persisting the grant, and keeping a valid access token available afterwards —
provider-neutral, with Google Sheets as one consumer rather than the subject.

## Solution

A new standard-library module `modules/oauth-client` (`metadata.name: OAuthClient`,
categories `[Security]`) implementing the OAuth 2.0 **client** role — the application asking for
access. The name leaves an `OAuthServer` module free for the authorization-server role later,
mirroring the existing http-client / http-server split.

Controllers ship **inside the module artifact**, not as an npm package — the `kv-store-memory` /
`kv-store-sql` shape. `modules/oauth-client/nodejs` is a private, never-published build package
(`@telorun/oauth-client-build`) that type-checks the sources and esbuild-bundles them to
`nodejs/*.mjs` with `@telorun/sdk` left external; `files: [nodejs/*.mjs]` puts those bundles in the
artifact, and each kind names its controller as `pkg:telo/local/js?path=./nodejs/<name>.mjs#<export>`.
Nothing third-party gets inlined: the token endpoint calls use the platform `fetch`, and PKCE uses
`node:crypto`.

Seventeen kinds, split so each is one operation with a precise input and output contract:

| Kind | Capability | Role |
| --- | --- | --- |
| `AuthorizationServer` | Provider | The server being talked to: its `issuer` identity, the endpoints reached on it, and the discovery that fills them in on first use. Carries no credentials. |
| `Client` | Provider | This application's registration at a server: credentials, scopes, PKCE mode, extra authorization parameters, and a ref to the `AuthorizationServer`. |
| `Authorization` | Invocable | Builds the consent URL; returns it with the generated `state` and PKCE verifier, and persists a single-use pending record keyed by `state` into its `source`'s store. |
| `RedirectListener` | Service | Binds `127.0.0.1:0` when run and publishes the resulting `{ redirectUri, port }`; teardown closes the socket. |
| `RedirectAwait` | Invocable | Blocks on a `RedirectListener` until the browser redirect arrives, returning `{ code, state }`. |
| `Callback` | Invocable | The browser-served counterpart to the loopback pair, wired as an `Http.Api` route handler. Holds an `authorization: !ref` to the `Authorization` it completes — store, client and pending-record shape are read through it. Takes `{ code, state, error }`, matches the pending record, exchanges the code, writes the grant, and returns the outcome for the route to render. |
| `TokenExchange` | Invocable | Authorization code → token set. |
| `TokenRefresh` | Invocable | Refresh token → token set. |
| `ClientCredentials` | Invocable | Machine-to-machine grant, no user present. |
| `DeviceAuthorization` | Invocable | Starts the device grant at the server's device endpoint; returns the user code and verification URI. |
| `DeviceToken` | Invocable | Polls the token endpoint until the user approves, denies, or the code expires. |
| `TokenSource` | Provider | Holds a `Client`, a `KvStore.Store` and a default grant key. The stateful half — nothing else persists. |
| `AccessToken` | Invocable | Returns a currently-valid access token from a `TokenSource`, refreshing inside a skew window. |
| `GrantRead` | Invocable | Reads the stored grant for a key — scope, expiry, whether one exists at all. |
| `GrantWrite` | Invocable | Persists a token set as the grant for a key. |
| `GrantClear` | Invocable | Removes the stored grant for a key (log out, revoke locally). |
| `Credential` | Invocable | Implements `Http.Credential`: authenticates every request made through an `Http.Client`, refreshing the token before expiry and again if the server rejects it. |

**Console login** is composed in the consumer's manifest, not baked into the module. The
`RedirectListener` is declared in the sequence's `with:` block and listed in its `targets:`, so the
kernel runs it before the steps and tears it down when the sequence ends — the same shape
`modules/crud/tests/crud-over-http.yaml` already uses to stand up an `Http.Server` around a test.
The steps are then `Authorization` → `Console.WriteLine` the URL → `RedirectAwait` →
`TokenExchange` → `GrantWrite`. The module never depends on `console`. Swapping the listener and
await for `Console.ReadLine` gives the paste-the-code variant; swapping them for
`DeviceAuthorization` + `DeviceToken` gives the headless variant with no browser on the machine.
Native desktop apps use the same loopback path — RFC 8252 puts them there deliberately.

Binding happens in `run()`, never `init()` — `init()` builds the socket's configuration and nothing
observable, exactly as `Http.Server` builds its app in `init()` and calls `listen()` in `run()`.
That the listener is bound **before** the consent URL exists then falls out of `targets:` running
ahead of the steps, and `resources.<listener>.status.redirectUri` is an ordinary value-flow read of state
the controller reports with `ctx.setStatus()` once `listen()` returns (see the prerequisite
below). Nothing is configured, nothing is reserved, and the listener is already accepting while the
user reads the URL.

**Browser-served login** replaces the last four steps with a single `Http.Api` route whose
`handler:` is `Callback`, because there the redirect arrives as a *separate* HTTP request that
shares no `steps.*` scope with the one that built the consent URL — possibly not even the same
instance. The two halves are joined by a declared reference, not by agreeing on a store: `Callback`
holds `authorization: !ref <Authorization>`, and reads the store, the client and the pending-record
key space through it. So the pairing is one edge in the manifest — visible to the analyzer, drawable
by the editor, and impossible to get half-right by pointing the two at different stores.

`Authorization` always writes the pending record keyed by `state` (the PKCE verifier, the redirect
URI, the grant key, a short TTL) into the store its `source` names; `source` is required, not an
optional field that switches the kind's behaviour. The console flow simply never reads the record
back — it carries the verifier through `steps.*` — and the TTL expires it. One code path, no branch.

The route maps `request.query` into the handler; `Callback` matches the `state` against the pending
record, exchanges the code, writes the grant and returns `{ ok, reason?, key?, scope? }`, which the
route's `returns:` block renders — a page, a redirect, whatever the consumer wants. `putIfAbsent`
plus a `compareAndDelete` on consumption make the pending record single-use, so a replayed callback
finds nothing.

A denied consent, an unknown `state` and an expired record are **returned outcomes**, not thrown
errors: they are legitimate ends of the flow that the response has to render, and `returns[].when`
selects on them with `result` statically typed from `Callback`'s `outputType`. A real failure — a
token endpoint 5xx, a malformed provider response — still throws and is never swallowed.

That typing needs one analyzer fix, carried by this change. `x-telo-context-ref-from` — what
`Http.Api`'s `returns:` uses to type `result` — resolves the referenced resource's `outputType` from
that resource's own **manifest** and falls back to an open schema when it finds none, so a kind that
declares its output once on its `Telo.Definition` (as `Callback` does, having one fixed output shape)
types nothing and `result.<typo>` passes. The fix is to fall back to the referenced resource's **kind**
before falling back to open — the same layering `buildStepContextSchema` already applies to
`steps.<name>.result`, so instance-level narrowing keeps winning where a kind exposes `outputType` as
an author field. It is generic, kind-agnostic, and every route handler in the standard library gains
it.

**Grant keys are per call, not per resource.** `TokenSource.key` is a default; `AccessToken` and the
three grant kinds accept a `key` input that overrides it, `Credential` takes one as configuration,
and `Authorization` records the key the callback should write. A browser-served flow is inherently multi-user, and even a CLI may
hold two accounts for one provider — the alternative is one `TokenSource` resource per account,
which cannot work when the account set is only known at runtime.

**Using the grant** attaches a credential to an `Http.Client`, and then there is nothing to use: a
plain `Http.Request` through that client is authenticated by construction. `OAuth.Credential`
extends a new `Http.Credential` abstract whose contract is "given the request about to be sent,
return the headers or query parameters to merge into it" — the request goes in, not just a token
request, so the same abstract carries API keys, HMAC signing and SigV4 later rather than bearer
schemes only. This is a companion change to `http-client`, described at the end.

That placement is what makes the three failure modes land where they belong. Clock skew sits inside
the credential, which refreshes within a skew window before returning a token. Network retries stay
in `Http.Request.retries`, untouched. A **401 is handled once in http-client's request controller**:
with a credential present, a rejection re-invokes the credential with `forceRefresh: true` and
retries the call once — so every credential type inherits the behaviour instead of each one
re-expressing it. `forceRefresh` is an ordinary declared input on the abstract's single operation,
not a second method: the credential decides what a forced refresh means — `OAuth.Credential`
bypasses its cached access token and refreshes, a static API key returns the same header unchanged.

The module imports `http-client` (for the `Http.Credential` abstract that `Credential` extends) and
`kv-store` (for the store ref on `TokenSource`, and for the `KeyedClaim` protocol a refresh claims
under), the same way `lease` imports `kv-store`. It does
**not** import `http-server`: `Callback` is a plain Invocable that a consumer's route references,
so the dependency runs the other way. PKCE needs random bytes and SHA-256; that stays private to
the controller rather than growing a `crypto` module in this change.

**Prerequisite: declared observed state** (`kernel/nodejs/plans/published-state.md`). This module is
that plan's first consumer and does not restate it. What it needs from it, and nothing more:

- `ctx.setStatus()` — the listener calls it once, immediately after `listen()` resolves, so the
  bound address becomes readable as ordinary value flow. Nothing here relies on the kernel's
  by-reference snapshot aliasing.
- Scoped resources reaching CEL — `resources.<scopedName>` resolves to nothing inside a `with:` block
  today, which is where this module's listener lives.
- A `status:` block on `Telo.Definition` — `RedirectListener` declares `port` and `redirectUri` as
  observed state, read as `resources.<listener>.status.*`. The configured port stays `port` in
  `schema:` and needs no rename: this kind is both configurable and self-discovering, and the segment
  is what keeps "the port you asked for" and "the port it got" apart without inventing a second word
  for one of them.

The prerequisite plan lands first, with its own tests, docs and changeset. It also buys this module
two checks it would otherwise lack: `resources.loopback.status.redirectUri` in an `Http.Client` field
— which the browser-side tests will reach for — is rejected at authoring time rather than silently
expanding to nothing, and reading the listener's reported state before it has run fails with an error
that names the resource and the field instead of a bare key error.

Together with `targets:` ordering, this lets the ephemeral port travel as a declared value rather
than through a controller reaching into a referenced instance, which is what keeps the data
dependency visible in the manifest, checkable by the analyzer and drawable by the editor.

**The companion http-client change.** A new `Http.Credential` abstract; a `credential` ref field on
`Http.Client`; and in the request controller, apply-and-merge before sending plus the 401
refresh-and-retry-once path. It carries its own docs, changeset and changie fragment, and it
lands first — `oauth-client` cannot extend an abstract that does not exist. The credential is always
reached through `ctx.invoke`, never a direct method call: a credential is consulted once per network
round-trip, so dispatch cost is noise next to the request itself, and a "call the method if the
instance happens to expose it" fast path is undeclarable in the schema, uncheckable by the analyzer
and unimplementable by a controller in any other language. `Telo.Sink`'s direct-call contract earned
itself on a per-record hot path; this is not one.

Alongside the manifest: `modules/oauth-client/docs/` plus a README, tests under
`modules/oauth-client/tests/` driving a fake authorization server built in-manifest from
`http-server`, a changie fragment for the module version, and a re-run of
`scripts/gen-changie-config.mjs`. The module itself takes no changeset — the build package is
private, so nothing publishes to npm and `metadata.version` is its only version; the analyzer and
http-client changes it depends on carry their own.

**Every kind ships tested**, all against the in-manifest fake server, so nothing reaches a real
provider. Both callback paths run unattended: an `Http.Request` stands in for the browser against the
loopback listener, while `Callback` is exercised directly — invoked with `{ code, state }` and
asserted on the grant it wrote — with one route test covering the wiring. The device grant gets a
fake device endpoint plus a token endpoint that returns `authorization_pending` before it returns a
token, so `DeviceToken`'s polling and its terminal outcomes (denied, expired) are covered rather than
assumed; `ClientCredentials` gets its own grant against the same server. Discovery is tested from the
issuer alone, with the explicit-endpoints path asserted to issue no discovery request at all.

## Decisions

- **`OAuthClient`, not `OAuth`** — OAuth's own vocabulary calls the requesting application the
  client; the authorization-server role is a separate future module, and the split matches
  http-client / http-server.
- **`metadata.name` is PascalCase, the directory and npm package stay kebab-case** — the module
  name is no longer a locator (imports resolve by source ref, and `x-telo-ref` targets are named by
  import alias), so it is free to read as a name rather than a slug. It still forms the canonical
  kind key (`OAuthClient.Client`) that diagnostics and the registry print, which is where the
  casing earns its keep. The directory is a filesystem path and npm forbids uppercase package
  names, so both remain `oauth-client`. Nothing enforces a pattern on `metadata.name`; the
  kebab-case convention in the kernel docs is convention only.
- **Controllers bundle into the module artifact rather than publishing to npm** — the direction
  the standard library is moving (`kv-store-*` already ship this way): one artifact carries the
  manifest and the code it declares, so a module version means one thing, the payload rides the
  existing `filesIntegrity` Merkle chain, and there is no npm release to keep in step with
  `metadata.version`. The Node package stays private and build-only because esbuild does not
  type-check and the inlined dependencies still have to be declared somewhere.
- **One kind per operation, never an `op:` discriminator** — a discriminator makes the input shape a
  union the analyzer cannot check per branch, and the hub's discovery model is one row per kind, so
  precise search hits beat one vague one. This governs both the four token-endpoint grants and the
  three grant-store operations (`cache` splits `Lookup` / `Entry` / `View`, `fs` splits `File` /
  `FileWrite` / `FileEdit` / `FileRemoval`; `Lease.Critical`'s `op: run | cancel` is the outlier,
  and it pays for it with a half-optional output type). No kind in this module takes an `op:`.
- **The consent URL, the redirect capture and the exchange are separate kinds** — the module stays
  free of console I/O, and each half is independently replaceable (paste-the-code, device flow, a
  future web callback). Rejected: a single `ConsoleLogin` kind that prints, listens and exchanges —
  simpler to call, but unusable outside a terminal and untestable without one.
- **`Callback` names the `Authorization` it completes** — the two halves of a browser-served flow run
  in different requests and share no `steps.*` scope, so the only thing that can join them is a
  declared reference. `authorization: !ref` makes that edge visible to the analyzer and the editor,
  gives `Callback` the store, client and key space from a single place instead of restating them, and
  removes the failure mode where the two resources are pointed at different stores and every callback
  reports an unknown `state`. It is the same argument that put the bound address into value flow
  rather than a controller side-channel. Rejected: `Callback` configured with its own `source` and
  matched to `Authorization` by convention — an undeclared coupling between two resources is exactly
  what this module refuses everywhere else. Rejected: `source` optional on `Authorization`, present
  only for browser flows — an optional field that switches a kind's behaviour is the polymorphic
  input shape the `op:` decision rejects; the record is cheap, always written, and TTL'd.
- **`Callback` is a plain Invocable behind an `Http.Api` route, not a Mount** — `routes[].handler`
  already accepts any Invocable, `routes[].inputs` already maps `request.query` into it, and
  `routes[].returns` already renders the response with `result` typed from the handler's
  `outputType`. So the module ships no request parsing, no response rendering and no HTML: the
  consumer owns the page (branding, localization, a redirect instead), the route is documented in
  the generated OpenAPI, and the handler is unit-testable by invoking it with `{ code, state }`
  instead of standing up a server. Rejected: `Callback` as a `Telo.Mount` — it would duplicate
  transport concerns http-server already owns and bury the browser-facing page inside a security
  module.
- **The loopback listener is a scoped Service run from `targets:`, not a two-phase Invocable** — a
  socket with a lifetime is what `Telo.Service` and `with:` already model, so the kernel opens and
  closes it instead of a controller holding a bound socket between two `invoke()` calls. That
  removes the `op: start | await` discriminator and makes the binding ordering fall out of
  `targets:` running ahead of the steps. The split into two kinds is **forced, not stylistic**:
  `targets:` accepts a `Telo.Runnable`/`Telo.Service` ref and a step's `invoke:` accepts a
  `Telo.Invocable` ref, so no single declared capability satisfies both slots. Rejected: an
  `announce:` step list on the capture — the `state` and PKCE verifier it would produce are needed
  by the *outer* steps, so they end up buried under `steps.<capture>.result.steps.<auth>.result…`,
  and the kind becomes a mini-sequencer duplicating `Run.Sequence`'s step machinery and typing
  inside a security module. Rejected: declaring the listener top-level — it binds a socket at boot
  for every run, including those that never log in.
- **The bound address travels as value flow, not through a ref side-channel** — the alternative was
  giving `Authorization` a `listener: !ref` slot and having its controller read the bound URI off
  the live instance, which needs no kernel change and is worse: the manifest stops showing where
  the redirect URI comes from, the analyzer cannot type it, the editor cannot draw the dependency,
  and `Authorization` grows a second mutually-exclusive way to be configured — the polymorphic
  input shape this module rejects everywhere else. With value flow, `Authorization` has exactly one
  `redirectUri` input and both flows supply it identically.
- **The bound address is reported through the declared-observed-state mechanism, not invented here** —
  the listener needed a way to report a value it learns while running, which is a kernel-level gap
  affecting every Service whose address or capacity is discovered rather than configured. It is
  designed and argued in `kernel/nodejs/plans/published-state.md` and lands before this module; this
  plan consumes it and adds no publication mechanism of its own.
- **The configured and the discovered port share the name `port`** — `RedirectListener` is both
  configurable and self-discovering, and `resources.<listener>.port` versus
  `resources.<listener>.status.port` says which is which on the face of the expression. Rejected:
  renaming the discovered one (`boundPort`) — a rename would be inventing a synonym to work around a
  namespace collision that the prerequisite's segment already removes.
- **This is the module's only HTTP listener, and it is loopback-only** — the console flow needs a
  socket bound before any server or URL exists, so it cannot be a route on a server that is not
  running yet. Should `Http.Server` ever report its bound address as observed state and gain a
  one-shot mode that releases its kernel hold, the console flow collapses into the same `Callback`
  route plus a wait-for-grant step and both kinds can be deleted; that is a change to http-server,
  not a reason to hold up this module.
- **Pending authorizations live in the grant store, single-use** — reusing `KvStore.Store` avoids a
  second storage dependency for a record that is short-lived and keyed the same way, and
  `putIfAbsent` + `compareAndDelete` make a replayed callback find nothing. Rejected: passing the
  verifier through a signed cookie or the `state` value itself, which puts a secret in the browser
  and rules out revoking a pending flow.
- **The grant key is a per-call input defaulting to `TokenSource.key`** — a browser-served flow
  serves many users from one resource, and the account set is a runtime fact. Rejected: one
  `TokenSource` per account, which can only express accounts known at authoring time.
- **`TokenSource` publishes no token through value flow** — a provider's `resources.<name>` value
  comes from `snapshot()` at init, so a token exposed that way would freeze at boot and go stale.
  `AccessToken` and `Credential` resolve it per invocation instead.
- **The credential attaches to the client; there is no request wrapper** — an authenticated call is
  an ordinary `Http.Request`, so it keeps http-client's own typing, timeouts, retries and streaming
  with nothing re-declared, and no unauthenticated inner resource exists for anything in the
  manifest to invoke and bypass auth with. Rejected: `OAuth.Request` holding an `x-telo-ref` to an
  `Http.Request` — that inner request is separately addressable, which is the bypass. Rejected:
  the same wrapper built as templated composition over `AccessToken` + `Http.Request` +
  `Run.Sequence` — it works, but costs ~45 lines of template YAML, a `run` dependency, and forcing
  `throwOnHttpError: false` on the inner call, all to express one `if` on `status == 401`. Rejected:
  a custom controller performing the call itself — `Http.Client` is pure config (its snapshot is
  `{baseUrl, headers, timeout, followRedirects}`), so the controller would have to reimplement the
  request path it was meant to reuse.
- **The credential takes the whole request, not just a token request** — `{ request: {method, url,
  headers, query}, forceRefresh }` in, `{headers?, query?}` out, so one abstract covers API keys in a
  query parameter, HMAC signing and SigV4, not bearer schemes alone. `headerName` and `scheme` stay
  configurable on the OAuth implementation; `AccessToken` stays public for anything outside HTTP
  entirely.
- **Invalidation is an input flag, not a second operation** — the abstract has exactly one operation,
  and `forceRefresh: true` on the retry is what distinguishes the second attempt from the first. That
  keeps `Http.Credential` a plain `Telo.Invocable`: one declared `inputType`, statically typed,
  implementable in any language. Rejected: a multi-method capability contract (`apply` +
  `invalidate`) — it needs a kernel change and buys nothing a declared input does not already carry.
  Rejected: the request controller reaching for an `invalidate()` method on the instance — a
  duck-typed side door that no schema declares and no non-Node controller can offer.
- **401 handling lives in http-client, once** — it is the one part that cannot be expressed by
  wiring, because a header is computed before the call and cannot react to a token the server has
  just rejected. Written in the request controller it serves every credential type; written in this
  module it would serve one. The retry happens once; a second failure propagates.
- **Persistence is a `KvStore.Store` ref, not a bespoke token file** — refresh tokens are exactly
  what that abstract is for (durable, non-evicting, atomic conditional writes), and the store
  choice stays the author's. A refresh writes the new grant with a compare-and-set against the
  version it read. A file-backed store, if wanted, is a separate `kv-store-file` module; local use
  today is `kv-store-sql` over sqlite.
- **Only one refresh per grant key is in flight, claimed on the grant store** — compare-and-set makes
  the *write* safe but not the *call*: both refreshes still reach the provider, and a provider that
  rotates refresh tokens treats the second presentation of a rotated token as replay, which RFC 6749
  §10.4 answers by revoking the whole grant. So the CAS loser does not merely lose a write — it can
  take the user's authorization down with it. `AccessToken` and `Credential` therefore claim
  `refresh:<grantKey>` before refreshing and release after, using `KeyedClaim` from
  `@telorun/kv-store` — the claim/settle/release protocol `Lease.Critical` and `Idempotency.Once` are
  both built on, so the guarantee is the standard library's rather than this module's, and it holds
  across processes as a browser-served deployment requires. Rejected: a `lease: !ref Lease.Critical`
  slot on `TokenSource`. `Critical` is a decorator that dispatches a **declared** `invoke:` body,
  and a refresh is controller-internal work with no resource to name there; wiring it anyway
  (`TokenSource → lease → Critical → TokenRefresh → source`) closes a reference cycle the dependency
  graph rejects outright, and breaking the cycle means hand-duplicating the client, store and key into
  a second resource that nothing checks agrees — a lease guarding a different key than the one being
  written is worse than no lease, because it looks wired. The declared `store:` edge is the real
  coordination boundary: the claim must be atomic against the same store the grant lives in, so a
  separately swappable backend could not be correct anyway. Rejected: an in-controller single-flight
  map, which covers one kernel only.
- **The loopback port is ephemeral, chosen by the OS at runtime** — a login flow is not a service,
  so it should not claim a port a real listener may want, fail when one instance is already
  running, or make the author configure a number that means nothing to them. Binding on scope entry
  is what makes this possible: the socket exists before the consent URL is built, so the URL can
  carry a port that did not exist a moment earlier, and the listener is already accepting while the
  user reads the URL rather than starting after it is printed. An explicit
  `port` remains configurable for providers that demand an exactly-registered redirect URI, and can
  be fed from the `ports:` block; loopback redirects on Google and any RFC 8252 provider accept any
  port. Rejected: a port declared in the Application's `ports:` block by default — it turns a
  transient socket into declared application surface.
- **The authorization server is its own resource, not fields on `Client`** — one describes a remote
  party, the other describes this application's registration at it, and the cardinality is
  one-to-many: a CLI registration and a web registration against the same issuer share one server
  resource and one discovery fetch instead of repeating both. It also gives the endpoints only a
  server can own (`deviceAuthorizationEndpoint`, and `revocationEndpoint` / `introspectionEndpoint`
  when they land) a home that isn't a client field describing someone else's deployment. Named
  `AuthorizationServer` after RFC 8414, not `Issuer`: the resource is the server and `issuer` is its
  identifier, so the name cannot be confused with an authorization-server *implementation*, whose
  issuer is self-configuration rather than a remote descriptor.
- **`AuthorizationServer` stays in this module for now** — the only other genuine consumer is a
  resource server (which needs `jwks_uri` and `iss` to validate incoming tokens, and no client
  credentials at all), and no such module exists. Deferring is cheap because `exports.kinds`
  re-export means a shared module can own the kind later while `oauth-client` re-exports it, so
  consumer manifests keep resolving unchanged.
- **Discovery configures any compliant provider from the `issuer` alone** — `<issuer>/.well-known/
  openid-configuration`, falling back to RFC 8414's `oauth-authorization-server`; explicitly given
  endpoints win. This is what keeps the module provider-neutral instead of a Google shape with the
  URLs swapped.
- **Discovery is lazy and memoized, never at `init()`** — `provide()` is already the declared lazy
  contract, resolved when a consumer asks rather than when the resource is built (`Mcp.SessionProvider`
  is called per invoke; `KvStore.Store` backends return a handle whose operations carry the I/O), so
  this needs no exception to the rule that `init()` performs no I/O — the same rule that puts
  `RedirectListener`'s bind in `run()`. A full explicit endpoint set skips discovery entirely, so a
  pinned or air-gapped deployment fetches nothing. The in-flight fetch is single-flighted on the
  instance, or a browser-served application taking concurrent callbacks after a restart fires one
  identical `.well-known` request per callback; unlike token refresh this contention is process-local,
  so an in-process promise is the whole mechanism. Rejected: fetching in `init()` — it buys fail-fast
  on a wrong issuer, which is a health-check concern and arrives as the same error at first use, and
  pays for it with a network round-trip on every boot of every consumer plus an outage mode strictly
  worse than the one it prevents: an unreachable authorization server would stop the application from
  *starting* rather than leaving it serving everything except login. Surviving a restart is a
  `Cache.Store` ref on `AuthorizationServer` later — freshness with eviction, as against the durable
  `KvStore.Store` holding grants — and is the extension point, not part of this change.
- **`iss` is verified, not just carried** — `Callback` and `TokenExchange` check RFC 9207's `iss`
  authorization-response parameter and any ID token's `iss` claim against the declared issuer. It is
  the defence against mix-up attacks, and it only became expressible once the issuer was a declared
  value rather than an optional string on whichever client was used. Shipping it later would change
  the behaviour of manifests already in the field.
- **Tokens are stored verbatim and never logged** — encryption at rest is the store's concern, and
  the client secret is bound through `secrets:` like any other credential.
- **Resource-owner password grant is excluded** — deprecated by the specification; adding it would
  invite the worst available flow.

## Example after the change

A login target and a call that uses the stored grant, in one application:

```yaml
kind: Telo.Application
metadata:
  name: sheets-demo
imports:
  OAuth: std/oauth-client@0.1.0
  Http: std/http-client@0.14.0
  KvStore: std/kv-store-sql@0.4.0
  Console: std/console@0.13.0
  Run: std/run@0.13.0
secrets:
  googleClientSecret:
    env: GOOGLE_CLIENT_SECRET
    type: string
variables:
  googleClientId:
    env: GOOGLE_CLIENT_ID
    type: string
targets:
  - ref: !ref login
---
kind: OAuth.AuthorizationServer
metadata:
  name: googleAccounts
issuer: https://accounts.google.com     # endpoints discovered from here
---
kind: OAuth.Client
metadata:
  name: google
authorizationServer: !ref googleAccounts
clientId: !cel "variables.googleClientId"
clientSecret: !cel "secrets.googleClientSecret"
scopes:
  - https://www.googleapis.com/auth/spreadsheets
pkce: S256
authorizationParams:
  access_type: offline
  prompt: consent
---
kind: OAuth.TokenSource
metadata:
  name: googleTokens
client: !ref google
store: !ref tokenStore
key: google/default
---
kind: Run.Sequence
metadata:
  name: login
with:
  - kind: OAuth.RedirectListener
    metadata:
      name: loopback
  - kind: OAuth.RedirectAwait
    metadata:
      name: awaitRedirect
    listener: !ref loopback
    timeout: 5m
targets:
  - !ref loopback                     # bound before the steps, closed when the sequence ends
steps:
  - name: auth
    invoke: !ref authorization
    inputs:
      redirectUri: !cel "resources.loopback.status.redirectUri"
  - invoke: !ref Console.writeLine
    inputs:
      output: !cel "'Open this URL to authorize:\n' + steps.auth.result.url"
  - name: callback
    invoke: !ref awaitRedirect
    inputs:
      state: !cel "steps.auth.result.state"
  - name: tokens
    invoke: !ref tokenExchange
    inputs:
      code: !cel "steps.callback.result.code"
      codeVerifier: !cel "steps.auth.result.codeVerifier"
      redirectUri: !cel "steps.auth.result.redirectUri"
  - invoke: !ref grantWrite
    inputs:
      tokens: !cel "steps.tokens.result"
```

Afterwards the credential rides the client, and calls through it are ordinary requests — no header
wiring, no manual refresh, and nothing to remember at each call site:

```yaml
kind: OAuth.Credential
metadata:
  name: googleAuth
source: !ref googleTokens
---
kind: Http.Client
metadata:
  name: sheets
baseUrl: https://sheets.googleapis.com/v4
credential: !ref googleAuth
---
kind: Http.Request
metadata:
  name: readSheet
client: !ref sheets
```

A browser-served application swaps the last four login steps for one route — the module supplies
the handler, the consumer owns the page. The handler names the `Authorization` it completes, so the
pending record it consumes is the one that resource writes:

```yaml
kind: OAuth.Authorization
metadata:
  name: authorization
source: !ref googleTokens          # client, store and default grant key come from here
---
kind: OAuth.Callback
metadata:
  name: oauthCallback
authorization: !ref authorization  # the flow this callback completes
---
kind: Http.Api
metadata:
  name: oauthRoutes
routes:
  - operationId: oauthCallback
    request:
      method: GET
      path: /callback
      schema:
        query:
          type: object
          properties:
            code: { type: string }
            state: { type: string }
            error: { type: string }
    inputs:
      code: !cel "request.query.code"
      state: !cel "request.query.state"
      error: !cel "request.query.error"
    handler: !ref oauthCallback
    returns:
      - when: !cel "result.ok"
        status: 200
        content:
          text/html:
            body: !cel "'<p>Signed in. You can close this tab.</p>'"
      - when: !cel "!result.ok"
        status: 400
        content:
          text/html:
            body: !cel "'<p>Sign-in failed: ' + result.reason + '</p>'"
```
