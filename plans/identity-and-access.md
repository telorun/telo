# Identity & access — roadmap

## Problem

Nothing serves authentication inbound. `Http.Server` / `Http.Api` have no authentication hook,
no cookie surface and no TLS, so there are no client certificates either; `Mcp.HttpEndpoint` is
unauthenticated, which the MCP authorization spec does not permit. The only auth code in the
standard library is the **outbound** half — `Http.Credential` (bearer, API key, query key) and
`oauth-client`, whose plan reserved the `OAuthServer` name for the other role. There is no
crypto / JOSE, mail or SMS module; every password, token, session, user, organization, role and
client concept is absent. An application that needs to know who is calling has to leave Telo.

The target is the whole identity-and-access surface a hosted identity platform offers — every
authentication method, and everything around it: users, credentials, sessions, organizations,
members, clients, APIs, roles, policies, consents, audit — delivered as modules an application
composes by import.

## Principles

- **One inbound seam, mirroring the outbound one.** `Http.Credential` says "request in → auth
  material out". Inbound is the inverse: an `Auth.Verifier` takes a credential *presentation*
  and returns an `Auth.Principal` or a refusal. Presentations are transport-neutral (a bearer
  token is the same over HTTP, MCP, WebSocket or gRPC metadata), so a verifier never sees a
  `request`; the transport extracts.
- **Contracts are abstracts; every backend is a module.** A user store, a session store, a
  policy engine, a connection type is an abstract with at least one shipped backend, so an
  application picks by import.
- **Composable by import, not by flag.** An application without organizations never imports
  `organization`; `Auth.Principal.org` is null. An application with one client declares it in
  the manifest; one whose customers register clients keeps them as rows. Everything a tenant
  configures — clients, connections, organizations, roles — exists in BOTH forms, manifest-
  declared and store-backed, because self-service SSO means a customer admin creates a SAML
  connection at runtime. The manifest declares which connection TYPES exist and which store
  holds their instances; the rows are the connections.
- **Secure by default, statically checked.** Once a mount declares `authentication:`, every
  route under it is protected unless it says `anonymous: allow`, and `telo check` reports a
  route that would be public by omission. Every token, password and secret slot carries
  `x-telo-sensitive`, so auth material never rides the debug wire.
- **Reuse what exists.** Sessions, pending records, denylists, consents → `KvStore.Store`;
  users, organizations, roles, clients → `Sql.Schema` declarative tables; lockout and
  throttling → `rate-limit`; key rotation and session sweep → `scheduler`; invitation and
  verification waits → `durable`; every auth event → the logging pipeline plus an audit table.
- **Login-pipeline extensibility is the step grammar.** What a hosted platform calls actions,
  rules or hooks (pre-registration, post-login, custom claims) are `onSignup:` / `onLogin:` /
  `onTokenIssue:` step bodies on the login kinds — declared, statically checked, no code.
- **The seam lives on the mount.** `authentication:` and `authorization:` are declared on
  `Http.Server.mounts[]`, with a per-route override on `Http.Api.routes[]`. Declaring them on
  the mount covers every `Telo.Mount` — `Mcp.HttpEndpoint`, `Http.Static`, a third-party
  mount — with no per-kind knowledge, and is what makes secure-by-default a checkable
  property rather than a convention. A wrapping guard mount and handler-level composition were
  rejected: neither gives the analyzer a fact to check.
- **One contracts module.** `auth` holds both the principal and the policy contract; splitting
  authentication from authorization would put the one type both halves share on a boundary.

## Prerequisites

- **Sensitive contract fields** (kernel, in flight): an invoke input or output marked sensitive
  is redacted on the debug wire. Every verifier's presentation and every token-issuing
  output depends on it.
- **Declarative UI** (`plans/declarative-ui.md`): the hosted login pages, the account pages
  and the management screens are `Ui.App` mounts over the same REST APIs. The APIs ship on
  their own phases; the screens wait for the renderer rather than shipping as static assets
  that would be rewritten.

## Phase 0 — transport-neutral primitives

| Module | Adds | Why first |
| --- | --- | --- |
| `crypto` (`Crypto`) | Random tokens, SHA / HMAC, constant-time compare, password hashing (`argon2id` default; verifies `bcrypt` / `scrypt` / `PBKDF2` for imported hashes), key derivation | `oauth-client` kept PKCE crypto private "rather than growing a crypto module"; five modules below need one |
| `jose` (`Jose`) | JWK / JWKS (`Jose.KeySet`: generation, rotation policy, publish, fetch + cache), JWS sign / verify, JWE encrypt / decrypt, JWT claims validation (`iss` / `aud` / `exp` / `nbf` / leeway, `typ`) | Every token-shaped credential, ID-token verification, stateless cookies, DPoP proofs, logout tokens |
| `mail` (`Mail`), `sms` (`Sms`) | `Mail.Send` (SMTP + provider adapters), `Sms.Send` abstract + one backend, templated messages | Verification, reset, magic links, OTP and invitations all deliver something |
| `http-dispatch` / `http-server` | `request.cookies` in every CEL context; `cookies:` on return entries (Secure / HttpOnly / SameSite / Domain / Path / `__Host-`); `tls:` on `Http.Server` (certificate, CA, `requestClientCertificate`) and `request.tls.clientCertificate`; the trusted-proxy certificate header under `trustProxy` | Sessions and mTLS have nowhere to land |

**Verify:** a route sets a cookie and reads it back on the next request; a client certificate
reaches CEL; a JWT signed under a rotated key still verifies through the published JWKS.

## Phase 1 — the seam, and token-based API authentication

### `auth` (`Auth`) — contracts

- `Auth.Principal` (`Telo.JsonSchema`): `subject`, `issuer`, `kind: user | service | anonymous`,
  `claims`, `scopes`, `roles`, `permissions`, `org` (nullable), `amr`, `acr`, `sessionId`,
  `authenticatedAt`, `via` (which verifier accepted it).
- `Auth.Presentation`: `bearer | basic | apiKey | cookie | signature | certificate | assertion`
  plus the material, all sensitive.
- `Auth.Verifier` (abstract): presentation → `{ principal }` or `{ refused, challenge? }`.
- `Auth.Chain`: ordered verifiers; first acceptance wins, refusals aggregate into one
  `WWW-Authenticate`.
- `Auth.Policy` (abstract): `{ principal, action, resource, context }` →
  `{ allow, reason, obligations }`.
- `Auth.Anonymous`; `Auth.TrustedHeader` (`X-Forwarded-User` and IAP / oauth2-proxy-style
  assertion headers, honoured only under `trustProxy`).

### `http-server` integration

- `authentication:` on `Http.Server.mounts[]` — which extractors (header, cookie, query,
  certificate) feed which verifiers, and `anonymous: allow | deny` — inherited by every
  route; `Http.Api.routes[]` overrides per route.
- `authorization:` per route: a `!ref` to an `Auth.Policy` plus `action:` / `resource:` CEL
  over `request`. A refused verifier renders 401 with the chain's challenge; a denied policy
  renders 403; both through the route's own `catches:` so the body is the author's.
- `request.principal` typed as `Auth.Principal` in `inputs:` / `returns:` / `catches:`.
- Diagnostics: `ROUTE_IMPLICITLY_PUBLIC` (the mount authenticates and the route says nothing),
  `AUTHZ_ACTION_MISSING` (a policy with no action or resource),
  `PRINCIPAL_READ_ON_PUBLIC_ROUTE`.
- `Mcp.HttpEndpoint` takes the same slot and serves RFC 9728 protected-resource metadata.

### Verifier modules

| Module | Methods |
| --- | --- |
| `auth-bearer` | JWT access tokens (JWKS, issuer, audience, algorithm allowlist, RFC 9068 `at+jwt`, DPoP-bound RFC 9449 and mTLS-bound RFC 8705 checks, `jti` denylist over `KvStore`); opaque tokens by introspection (RFC 7662); opaque tokens from an own token table |
| `api-key` | Issuance (prefix, hashed at rest, shown once), verification, scopes, expiry, rotation, revocation, owner (user, service or organization — a personal access token is the same kind with a user owner), presentation by header, query or Basic username, key id as the `rate-limit` bucket |
| `auth-basic` | HTTP Basic (RFC 7617) and Digest (RFC 7616) over an `Auth.PasswordVerifier` abstract, implemented later by `identity` and `ldap` |
| `session` | Server-side sessions over `KvStore.Store` (idle and absolute expiry, device / user-agent / IP, rotation on privilege change, per-user listing and revocation, "log out everywhere", remember-me); stateless signed or encrypted cookie sessions via `jose`; CSRF (synchronizer token, double-submit, Origin and Sec-Fetch checks); `Session.Verifier` |

**Verify:** an API accepts tokens from an external provider (Auth0, Okta, Entra) and its own
API keys, rejects a tampered JWT and a revoked key, and `telo check` flags a route left public
by omission. Example application: *API-key-only microservice*.

## Phase 2 — first-party identity

| Module | Scope |
| --- | --- |
| `identity` (`Identity`), `identity-sql` | `Identity.Store` abstract. Users (profile, `userMetadata` / `appMetadata`, blocked, last login); identifiers (email / phone / username policies, uniqueness, verification state); linked identities (`provider`, `subject`) and account-linking rules; password credential over `crypto` with policy (length, history, breach check through the HIBP range API); the `Auth.PasswordVerifier` implementation; signup modes (open, invite-only, disabled); reset and change flows; search; import / export as NDJSON; GDPR export and erasure; lazy migration from a legacy store on first login |
| `identity-external` | Bring-your-own user store: `lookup:` and `verify:` step bodies against any system — the platform "custom database script" as declarative steps, statically checked |
| `passwordless` | One-time links and codes (single-use, TTL, bound to the requesting browser through a pending record as `oauth-client` does); magic-link login; email / SMS OTP login. Email and phone verification, password reset and invitations reuse the same kinds |
| `protection` | Brute-force lockout per account and per IP over `rate-limit`; suspicious-IP throttling; breached-password refusal; `Captcha.Verify` abstract with Turnstile / reCAPTCHA / hCaptcha backends; IP and email-domain allow / deny lists; disposable-domain list; new-device and new-location signals consumed by MFA policy |
| `audit` | Append-only auth events (login success and failure with reason, MFA, token issued and revoked, consent, administrative action, session revocation) with actor, target, IP and user agent; an audit table plus a `Telo.Sink` so events stream through the logging pipeline; retention; a query API |
| Login hooks | `onSignup:` / `onLogin:` / `onTokenIssue:` step bodies on the login kinds |

**Verify:** password login locks after N failures, a reset link works exactly once, one audit
row per attempt. Example application: *web application with sessions, no organizations*.

## Phase 3 — federation and strong authentication

| Module | Scope |
| --- | --- |
| `federation` (`Federation`) | OIDC relying party over `oauth-client`'s flows plus ID-token verification (`jose`, nonce, `at_hash`); claims → principal mapping; just-in-time provisioning; account linking; generic OAuth 2 providers (no OIDC, userinfo mapping); social presets as data (Google, Apple with its client-secret JWT, GitHub, Microsoft / Entra, Facebook, LinkedIn, X, Discord, GitLab, Slack); identifier-first login and home-realm routing by email domain; connections as manifest resources or as rows |
| `webauthn` (`WebAuthn`) | Passkeys / FIDO2 registration and assertion; credential store (counter, backup flags, transports); discoverable / usernameless login; attestation policy; usable as primary factor and as MFA factor |
| `mfa` (`Mfa`) | TOTP / HOTP (RFC 6238 / 4226, provisioning URI); recovery codes; email / SMS OTP; WebAuthn factor; push abstract (vendor adapters later); policy — always, per organization, adaptive on `protection` signals; step-up through `acr_values` and `amr` on the principal, with policies requiring `mfa` in `amr`; trusted-device cookie; factor management |

**Verify:** "Sign in with Google" creates and links a user; a passkey signs in without a
password; a policy demanding MFA rejects a session that has none.

## Phase 4 — authorization, organizations, administration

| Module | Scope |
| --- | --- |
| `authz` (`Authz`) | RBAC — roles, permissions per API / resource server, assignments to users and organization members — over an `Authz.Store` abstract with a SQL backend; `Authz.CelPolicy`, ABAC as CEL over `principal` / `resource` / `context`, typed statically; a permissions claim in tokens; row-level filters for `sql-repository` |
| `authz-rebac` | Relation tuples with a schema (`viewer: user or editor`); check, expand, list-objects — the fine-grained-authorization equivalent |
| `authz-opa`, `authz-cedar` | `Auth.Policy` over an external engine through `http-client` |
| `organization` (`Organization`) | Organizations, members, member roles, invitations (accept flow over `passwordless`), organization-scoped connections (which login methods an organization allows; enterprise connection rows are self-service SSO), organization picker and domain routing at login, `org_id` and organization claims in tokens, branding data. Optional import |
| `iam-management` | The management API: a library exporting `Http.Api` mounts configured through `resources:` inputs — users, organizations, roles, clients, connections, sessions, audit; delegated administration (organization admins scoped by `authz`); audited, time-boxed impersonation carried as an `act` claim. Screens follow in phase 7 |
| `iam-account` | Self-service `/me` API: profile, password, factors, sessions and devices, connected applications and consents, data export and deletion. Screens follow in phase 7 |

**Verify:** two organizations, one user in both with different roles; a CEL policy and a ReBAC
check answer the same question identically. Example application: *B2B SaaS with organizations,
SSO and RBAC*.

## Phase 5 — the authorization server and OpenID provider

`oauth-server` (`OAuthServer`), the role `oauth-client`'s plan reserved the name for.

- **Clients** (manifest or rows): public / confidential, exact redirect URIs, allowed grants,
  authentication methods (`client_secret_basic`, `client_secret_post`, `private_key_jwt`,
  `tls_client_auth`, `none`), first-party consent skip, token lifetimes, allowed origins,
  logout URIs. **Resource servers**: audience, scopes, `jwt | opaque`, signing algorithm,
  RBAC in the token. **Client grants**: which client may call which API with which scopes.
- **Grants**: authorization code with PKCE (S256 required for public clients); refresh with
  rotation and reuse detection revoking the family; client credentials; device (RFC 8628);
  token exchange (RFC 8693); JWT bearer assertion (RFC 7523); CIBA over `mfa` push. Implicit
  and resource-owner password are deliberately absent (OAuth 2.1).
- **Endpoints**: authorize, token, introspect (RFC 7662), revoke (RFC 7009), userinfo, jwks,
  discovery (`openid-configuration` and `oauth-authorization-server`), device authorization,
  pushed authorization requests (RFC 9126), dynamic client registration (RFC 7591 / 7592,
  optional and protectable), end-session with back-channel (logout token) and front-channel
  logout.
- **OIDC core**: ID token, nonce, `prompt` / `max_age` / `login_hint` / `acr_values` /
  `claims`, standard claims from `identity`, `org_id` from `organization`.
- **Advanced profiles**: DPoP (RFC 9449), mTLS-bound tokens (RFC 8705), resource indicators
  (RFC 8707), rich authorization requests (RFC 9396), JWT-secured authorization requests
  (RFC 9101), issuer identification (RFC 9207); **FAPI 2.0** as one preset.
- Consent (stored per client and scope, with scope descriptions); key rotation through `jose`
  under `scheduler`; a headless authentication API for embedded and SPA login.

**Verify:** the OpenID Foundation conformance suite (Basic OP, then FAPI 2.0); this repo's
`oauth-client` is the first relying party. Example applications: *standalone identity provider
serving other applications*; *MCP server protected by its own authorization server*.

## Phase 6 — enterprise and machine identity

| Module | Scope |
| --- | --- |
| `saml` (`Saml`) | Service provider: SP- and IdP-initiated, redirect and POST bindings, metadata, XML-DSig verification, encrypted assertions, single logout, attribute → principal mapping; connections as rows for organization self-service. Identity provider role afterwards, for applications that only speak SAML |
| `ldap` (`Ldap`) | Bind verification as an `Auth.PasswordVerifier`, search, group → role mapping, Active Directory, StartTLS |
| `auth-mtls` | Client-certificate verification (chain to trusted CAs, CRL / OCSP optional), SAN → principal, SPIFFE SVIDs (X.509 and JWT), workload identity federation |
| `auth-signature` | HTTP Message Signatures (RFC 9421), SigV4-style signing, webhook `t=…, v1=…` schemes with a replay window, presigned / capability URLs — and the outbound `Http.Credential` twin of each scheme |
| `scim` (`Scim`) | SCIM 2.0 server (RFC 7643 / 7644): Users, Groups, filter grammar, PATCH, bulk; mapped onto `identity` and `organization`; outbound provisioning client afterwards |
| `auth-negotiate` | Kerberos / SPNEGO — a native dependency, shipped as an env-missing candidate; last and best-effort |

## Phase 7 — screens and production hardening

- **Screens**, on the declarative UI renderer: `login-ui` (login, signup, MFA, consent,
  device code, reset, invitation, organization picker) as an exported mount, branded through
  variables and localized; management screens over `iam-management`; account screens over
  `iam-account`.
- Horizontal scale: no in-process state anywhere, every store an abstract; key rotation and
  session sweep under `scheduler`; i18n of pages and messages.
- A threat-model document per module; a security review of every verifier's failure mode
  (fail closed, constant time); load tests on the token and session paths.
- Documentation and hub descriptions per module; the authoring-agent primer updated with the
  seam and the profiles; the five example applications kept as tests.

## Verification across the whole roadmap

Each phase ends with a manifest test suite per module, the phase's example application under
`examples/`, and `telo check` clean on every example. The two external oracles are the OpenID
conformance suite for phase 5 and a passing FAPI 2.0 profile after it. A phase is not done
while its example application needs a `JS.Script`.
