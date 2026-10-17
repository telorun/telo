# Public URLs

An application declares every address it is reached at as a need: a single address as `Telo.PublicUrl`, a family of tenant hosts as `Telo.PublicHostPattern`. Several may name one port. An `Http.Server` mount names the needs it answers, so the application never writes a domain name, and the request's host selects the mount. Whoever runs the application — a runner, Telo Cloud, any other host — reads the needs from `telo needs report`, supplies each, and routes its hosts to the port with the host and path unchanged. `Http.Server.baseUrl` is removed.

## Before / After

- **Before.** The `Telo.PublicUrl` type is planned with only a `port` parameter, and its template must contain `{port}`. `Http.Server` matches mounts by path only and advertises one fixed `baseUrl`. A tenant subdomain or a customer's own domain has no declaration at all.
- **After.**
  - `Telo.PublicUrl` has `port`, `primary` and `customDomains`.
  - `Telo.PublicHostPattern` declares tenant hosts in both `*.sub.domain.com` and `*-sub.domain.com` form.
  - An `Http.Server` mount restricts the hosts it answers with `hostnames`, a list of references to those needs.
  - Every scenario in the table below is expressible by the application and servable by a host meeting the contract.

## Address needs

Both types are kernel-declared need types. A library declares them with no parameters, having no `ports:` of its own. The root declares its own, naming a port, and forwards it at the import.

### `Telo.PublicUrl`

One address.

| Parameter | Meaning |
|---|---|
| `port` | A key of the root's `ports:` naming a `tcp` port. Required at the root. |
| `primary` | `true` marks the application's main address. Default `false`. |
| `customDomains` | `true` lets the host route further domains to this need's port, ones the application is never told about. Default `false`. |

- **The field** is `url`, a `Telo.Url`. Its host is `resources.<need>.url.host`. A URL supplied with a path keeps that path, and the application serves it as written; no host rewrites a path.
- **The primary.** A root need with `primary: true` is the primary. When the root declares exactly one `Telo.PublicUrl`, that one is the primary without stating it. With several and none marked, there is no primary.
- **One `customDomains` need per port.** A domain the host routes to a port must trace to one need, so at most one `Telo.PublicUrl` per port may set it.

### `Telo.PublicHostPattern`

A family of hosts, for tenant subdomains.

| Parameter | Meaning |
|---|---|
| `port` | A key of the root's `ports:` naming a `tcp` port. Required at the root. |

- **The field** is `pattern`: `<scheme>://<hostname pattern>[:<port>]`, with scheme `http` or `https` and nothing after the host or port.
  - Examples: `https://*.tenants.shop.example`, `https://*-tenants.shop.example`, `http://*.tenants.localhost:8080`.
  - A value outside this grammar is refused as any need field that does not match its schema: at `telo check` for a literal fulfilment, `ERR_MANIFEST_VALIDATION_FAILED` for an environment value.
- **A tenant's address** is `resources.<need>.pattern.replace('*', tenant)`. Producing a valid hostname label is the application's concern.
- **The template never answers it.** It comes from a `needs:` supply or its env name (`TELO_NEED_<NAME>__PATTERN`), or is `ERR_NEED_UNMET`.

### Hostname patterns

A hostname is matched case-insensitively, with any port ignored and a trailing dot ignored. `*` may appear only at the start of the first label, in one of two forms:

- **The whole first label:** `*.<rest>`. `*` stands for one or more whole labels, so `*.tenants.shop.example` matches `acme.tenants.shop.example` and `a.b.tenants.shop.example`, and never `tenants.shop.example`.
- **Part of the first label:** `*<text>.<rest>`, where `<text>` is non-empty, such as `*-tenants.shop.example`. `*` stands for a non-empty run of characters inside that one label, so the pattern matches `acme-tenants.shop.example` and never `a.b-tenants.shop.example` or `-tenants.shop.example`.

A pattern's literal suffix is everything after the `*`: `.tenants.shop.example` and `-tenants.shop.example` above.

### Collisions

At load, before any resource initializes, two address needs naming one port are refused with `ERR_NEED_PUBLIC_URL_COLLISION` when either is true:

- two `Telo.PublicUrl` URLs have the same host;
- two `Telo.PublicHostPattern` patterns have the same literal suffix in the same form.

The refusal names both needs, the port and the host or pattern. This is a runtime refusal only, because the values come from the environment. Needs on different ports may share a host. An exact host that a pattern on the same port also matches is not a collision: precedence decides.

### Deriving addresses from the template

`TELO_HOST_PUBLIC_URL_TEMPLATE` answers `Telo.PublicUrl` needs only. It is an `http` or `https` URL with a host and nothing after it; `{port}` in the host is optional. Anything else is `ERR_NEED_HOST_VALUE_INVALID`.

1. **The label.** Each need has a label: its name lowercased, with `_` written as `-`. `admin` is `admin`, `admin_api` is `admin-api`.
2. **The base address.** A need's base address is the template with `{port}` replaced by its port's number. A template without `{port}` is one base address for every need.
3. **Who gets the base.** Among the needs sharing a base address, the primary gets it. When no primary shares it, the only need sharing it gets it.
4. **Everyone else** gets the base address with `<label>--` in front of the host's first label. `https://8080-s1.example.dev` becomes `https://admin--8080-s1.example.dev`. The host keeps its number of labels, so a wildcard certificate for the base domain still covers it.
5. **Invalid labels.** A derived first label over 63 octets, or one starting with `-`, is `ERR_NEED_HOST_VALUE_INVALID`. The refusal names `TELO_HOST_PUBLIC_URL_TEMPLATE` and the need.

### Announced to runners

Each port entry of `Kernel.PortsResolved` gains `publicUrls: [{ need, host }]`: every `Telo.PublicUrl` need naming that port, with the host its URL resolved to. The event is re-emitted on every load. A runner that reads the event tolerantly ignores the field until it is updated.

## `Http.Server` host routing

### `hostnames` on a mount

A mount entry gains `hostnames`, a list of at least one reference to a `Telo.PublicUrl` or `Telo.PublicHostPattern` need, beside `path`.

- **What an entry matches.**
  - A `Telo.PublicUrl` entry matches its URL's host, exactly.
  - A `Telo.PublicHostPattern` entry matches its pattern.
  - A `Telo.PublicUrl` with `customDomains: true` also matches every host that no exact or pattern entry of the server claims.
- **What an entry may be.** Only a reference: a domain name cannot be written in a manifest.
  - A string entry is refused at `telo check` as a value at a reference slot.
  - A reference to anything but those two need types is `REFERENCE_KIND_MISMATCH`.
  - A reference to an optional need is `NEED_OPTIONAL_REFERENCED`.
- **Unrestricted mounts.** A mount without `hostnames` answers every host.
- **The port check.** A controller resolving one of these needs through `ctx.resolveNeed` also receives the number of the port the need names. A server holding an entry whose need names a port other than the one it listens on refuses at creation with `ERR_HOSTNAMES_PORT_MISMATCH`. The refusal names the need, its port and the server's port.
- **Applied to every route.** The server applies a mount's `hostnames` to every route the mount registers, as it applies `path`. `Http.Api`, `Http.Static`, `Http.Reference`, `Mcp.HttpEndpoint` and `UiReact.App` are unchanged.
- **Annotations.**
  - The field carries `x-telo-topology-role: matcher`, as `path` does.
  - Its item schema is `$defs/Hostnames` on the `HttpDispatch.Request` carrier, referenced through `x-telo-schema-from`, so any HTTP transport reads the same matcher with the same meaning.
- **Not an access boundary.** Any client can send any `Host`, so `hostnames` only routes. A sub-tree that must be protected is protected by its mount's `guard`, and the docs say so.

### The request's host

The server derives one host per request, and uses it for routing, the OpenAPI origin, the access log and `request.host`:

- the `Host` header, or `:authority` on HTTP/2, with the port removed, lowercased, and a trailing dot ignored;
- replaced by `X-Forwarded-Host` only when `trustProxy` is set or `trustForwardedHeaders` is `true`; otherwise `X-Forwarded-Host` is ignored.

`request.host` is added to the CEL context of `Http.Api` routes, their `catches:`, and mount `guard` inputs. A handler then reads the trusted host, and finds its tenant there, rather than reading the raw header.

### Precedence

For one request, the server considers three classes in order. The first class holding a route that matches the request's path and method answers:

1. mounts with an exact entry equal to the host;
2. mounts with a pattern entry matching the host, longest literal suffix first;
3. unrestricted mounts and mounts naming the port's `customDomains` need.

Within one class the existing path matching decides. A request matching no route reaches the server's not-found handler. Two mounts of one class registering the same method and path for the same host, or for the same pattern, fail server init, as two same-path routes do today.

### OpenAPI

The document an `Http.Reference` serves lists exactly the routes reachable on the host of the request that fetched it, under the precedence above. Its `servers` entry is relative (`/`). With `trustProxy` set or `trustForwardedHeaders: true`, it is the request's own origin.

### `baseUrl` is removed

- `Http.Server.baseUrl` is removed with no replacement. It also leaves the `<name>.Listening` event payload.
- Its one use was the OpenAPI `servers` entry, which the rule above answers correctly on every host. A fixed value would be right on at most one host.
- A route that builds an absolute link reads `resources.<need>.url`, or replaces `*` in `resources.<need>.pattern`.
- The `Http.Server` schema becomes closed (`additionalProperties: false`), so a manifest still writing `baseUrl:` fails with `SCHEMA_VIOLATION` rather than being ignored.
- There is no migration entry, since nothing is equivalent. Every in-repo manifest setting it on an `Http.Server` is edited.

### Studio

The topology entry list renders every `matcher` field of an entry, `hostnames` and `path`, read from `x-telo-topology-role` with no kind-specific code. `hostnames` is edited through the reference picker, which offers the address needs. It renders one matcher field today.

## The host contract

What any host serving an application's addresses does. The runner docs state it once, and Telo Cloud is held to it like any other host.

1. **Reads the needs from `telo needs report -o json`.** For each address need that gives its type, `port`, `primary` and `customDomains`, and the env name of its field. Nothing else about the application is read.
2. **Gives each `Telo.PublicUrl` a URL** whose host no other address need on that port has, routes that host to the port, and supplies `url`. `primary` marks the need the host gives its main address. How the host names addresses is its own choice.
3. **Gives each `Telo.PublicHostPattern` a pattern** in either form, whose literal suffix no other pattern on the port shares in the same form. It routes every host matching the pattern to the port, and supplies `pattern`.
4. **May route further domains to the port of a `customDomains` need,** exact or `*.` wildcards. It supplies nothing for them.
5. **Routes without changing the request.** Every route delivers to the port with the path unchanged and the host as the client sent it, in `Host`, or in `X-Forwarded-Host` when the application trusts the proxy. A host never routes one hostname to two ports.
6. **Owns TLS, certificates and DNS.** The application holds no certificate and registers nothing. It learns of a domain only through a fulfilment.
7. **May redirect a domain instead of routing it.** The application never sees a redirected request.
8. **Leaves unsupplied any need it cannot serve,** such as a pattern on a host with no wildcard routing. The load is then `ERR_NEED_UNMET`, naming the env name.

## Scenarios

| # | Scenario | The application declares | The host |
|---|---|---|---|
| 1 | One server, one address | one `Telo.PublicUrl` | routes its host to the port and supplies `url` |
| 2 | One server, a primary and secondary addresses | several `Telo.PublicUrl` on one port, one `primary`, one mount per need | gives each a distinct host and routes all of them to the port |
| 3 | Several servers, one address each | one `Telo.PublicUrl` per port | routes each host to its own port |
| 4 | Several servers, one with several addresses | rows 2 and 3 combined | as rows 2 and 3 |
| 5 | Several addresses, no primary | no `primary` | as row 2; whether a bare main address exists is its choice |
| 6 | Tenants on the host's own domain, `*.sub` form | a `Telo.PublicHostPattern` | supplies a `*.…` pattern it can serve and routes every match to the port |
| 7 | Tenants on the host's own domain, `*-sub` form | a `Telo.PublicHostPattern` | supplies a `*-…` pattern and routes as row 6. One label below its domain, so its existing wildcard certificate covers it |
| 8 | Tenants on the operator's own wildcard domain | a `Telo.PublicHostPattern` | supplies the operator's pattern, such as `https://*.shop.com`, and routes as row 6 |
| 9 | Customer domains | `customDomains: true` on one need of the port | routes each domain attached to the need to its port |
| 10 | Customer wildcard domains | as row 9 | as row 9, with a `*.` attachment |
| 11 | A customer domain as the main address | any `Telo.PublicUrl` | supplies the customer's URL as `url` |

In every row the application writes no domain name, and the tenant or customer is found through `request.host`. Locally every row is env values, with `*.localhost` for patterns, since browsers resolve it to loopback. On a k8s session rows 1–5 come from the template and rows 6–11 from the session's env.

## Examples

Assumptions used in every example:
- The routers (`site`, `admin`, `tenant`, `health`, …) are `Http.Api` resources declared elsewhere in the module, and `adminAuth` an invocable checking a credential.
- `<release>` is the release that ships this plan.
- The host's values are written for a host whose domain is `shop.example`.

### 1. One server, one address

```yaml
kind: Telo.Application
metadata: { name: Shop, version: 1.0.0 }
requires: { telo: ">=<release>" }
imports:
  Http: oci://ghcr.io/telorun/http-server@<release>
ports:
  http: { env: PORT, default: 8080 }
needs:
  site:
    kind: Telo.PublicUrl
    parameters: { port: http }
targets:
  - !ref server
---
kind: Http.Server
metadata: { name: server }
port: !cel "ports.http"
mounts:
  - path: /
    mount: !ref site
```

- `site` is the only `Telo.PublicUrl`, so it is the primary. A server with one address needs no `hostnames`.
- **Host:** `TELO_NEED_SITE__URL=https://shop.example`, with `shop.example` routed to `http`.
- **k8s session:** `https://8080-<session>.<base>` from the template.
- **Locally:** `TELO_NEED_SITE__URL=http://localhost:8080`.

### 2. One server, a primary and a secondary address

```yaml
kind: Telo.Application
metadata: { name: Shop, version: 1.0.0 }
requires: { telo: ">=<release>" }
imports:
  Http: oci://ghcr.io/telorun/http-server@<release>
ports:
  http: { env: PORT, default: 8080 }
needs:
  site:
    kind: Telo.PublicUrl
    parameters: { port: http, primary: true }
  admin:
    kind: Telo.PublicUrl
    parameters: { port: http }
targets:
  - !ref server
---
kind: Http.Server
metadata: { name: server }
port: !cel "ports.http"
mounts:
  - path: /healthz
    mount: !ref health
  - hostnames: [ !ref site ]
    path: /
    mount: !ref site
  - hostnames: [ !ref admin ]
    path: /
    mount: !ref admin
    guard:
      invoke: !ref adminAuth
      inputs:
        authorization: !cel "request.headers.authorization"
```

- **Routing.**
  - `health` is unrestricted, so a probe sent to the pod's address reaches it on any host.
  - `site` and `admin` each answer only their own host, and the admin routes are not reachable on the site host at any path.
- **Host:** `TELO_NEED_SITE__URL=https://shop.example` and `TELO_NEED_ADMIN__URL=https://admin.shop.example`, both routed to `http`.
- **k8s session:**
  - `site` reads `https://8080-<session>.<base>`.
  - `admin` reads `https://admin--8080-<session>.<base>`, which the runner routes from `publicUrls`.
- **Locally:** `TELO_NEED_SITE__URL=http://localhost:8080 TELO_NEED_ADMIN__URL=http://admin.localhost:8080`. Setting both to `http://localhost:8080` refuses the load with `ERR_NEED_PUBLIC_URL_COLLISION`.

### 3. Several servers, one address each

```yaml
kind: Telo.Application
metadata: { name: Shop, version: 1.0.0 }
requires: { telo: ">=<release>" }
imports:
  Http: oci://ghcr.io/telorun/http-server@<release>
ports:
  http: { env: PORT, default: 8080 }
  admin: { env: ADMIN_PORT, default: 8081 }
needs:
  site:
    kind: Telo.PublicUrl
    parameters: { port: http, primary: true }
  admin:
    kind: Telo.PublicUrl
    parameters: { port: admin }
targets:
  - !ref server
  - !ref adminServer
---
kind: Http.Server
metadata: { name: server }
port: !cel "ports.http"
mounts:
  - path: /
    mount: !ref site
---
kind: Http.Server
metadata: { name: adminServer }
port: !cel "ports.admin"
mounts:
  - path: /
    mount: !ref admin
    guard:
      invoke: !ref adminAuth
      inputs:
        authorization: !cel "request.headers.authorization"
```

- Each server has one address, so neither needs `hostnames`.
- **Host:**
  - `TELO_NEED_SITE__URL=https://shop.example`, routed to `http`.
  - `TELO_NEED_ADMIN__URL=https://admin.shop.example`, routed to `admin`.
- **k8s session:** each port has its own base, so each need is the only one on its base.
  - `site` reads `https://8080-<session>.<base>`.
  - `admin` reads `https://8081-<session>.<base>`.
- **Locally:** `TELO_NEED_SITE__URL=http://localhost:8080 TELO_NEED_ADMIN__URL=http://localhost:8081`. The hosts are equal but the ports differ, so this is not a collision.

### 4. Several servers, one with several addresses

Example 3, with a third need on port `admin` and the admin server's mounts restricted:

```yaml
needs:
  site:
    kind: Telo.PublicUrl
    parameters: { port: http, primary: true }
  admin:
    kind: Telo.PublicUrl
    parameters: { port: admin }
  status:
    kind: Telo.PublicUrl
    parameters: { port: admin }
---
kind: Http.Server
metadata: { name: adminServer }
port: !cel "ports.admin"
mounts:
  - hostnames: [ !ref status ]
    path: /
    mount: !ref status
  - hostnames: [ !ref admin ]
    path: /
    mount: !ref admin
    guard:
      invoke: !ref adminAuth
      inputs:
        authorization: !cel "request.headers.authorization"
```

- **Host:** `admin.shop.example` and `status.shop.example`, both routed to `admin`.
- **k8s session:** `admin` and `status` share the base `https://8081-<session>.<base>`, and neither is the primary, so both are derived.
  - `admin` reads `https://admin--8081-<session>.<base>`.
  - `status` reads `https://status--8081-<session>.<base>`.
  - The port's own host reaches no mount, since this server has no unrestricted one.
- **`hostnames: [ !ref site ]` on `adminServer`** refuses the server at creation with `ERR_HOSTNAMES_PORT_MISMATCH`: `site` names `http`, and the server listens on `admin`.

### 5. Several addresses, no primary

Example 2 without `primary: true`.

- **Host:** both needs still get distinct hosts. Whether `shop.example` itself is routed, and to which need, is the host's choice. The application only learns the two URLs it is given.
- **k8s session:** both needs read a `<label>--` host. The port's own host reaches only `health`.

### 6. Tenants on the host's own domain, `*.sub` form

```yaml
kind: Telo.Application
metadata: { name: Shop, version: 1.0.0 }
requires: { telo: ">=<release>" }
imports:
  Http: oci://ghcr.io/telorun/http-server@<release>
ports:
  http: { env: PORT, default: 8080 }
needs:
  site:
    kind: Telo.PublicUrl
    parameters: { port: http, primary: true }
  tenants:
    kind: Telo.PublicHostPattern
    parameters: { port: http }
targets:
  - !ref server
---
kind: Http.Server
metadata: { name: server }
port: !cel "ports.http"
mounts:
  - hostnames: [ !ref tenants ]
    path: /
    mount: !ref tenant
  - hostnames: [ !ref site ]
    path: /
    mount: !ref site
```

- **Routing.** `tenant`'s routes read the tenant as `request.host.split('.')[0]`. `site` builds a tenant's link as `resources.tenants.pattern.replace('*', tenantId)`.
- **Host:** `TELO_NEED_TENANTS__PATTERN=https://*.tenants.shop.example`, with every match routed to `http`.
- **Locally:** `TELO_NEED_TENANTS__PATTERN=http://*.tenants.localhost:8080`, so `http://acme.tenants.localhost:8080` reaches `tenant`.
- **k8s session:** the template does not answer it, so the session's env sets it or the load is `ERR_NEED_UNMET` naming `TELO_NEED_TENANTS__PATTERN`.

### 7. Tenants on the host's own domain, `*-sub` form

The manifest of example 6, unchanged.

- **Host:** `TELO_NEED_TENANTS__PATTERN=https://*-tenants.shop.example`. `acme-tenants.shop.example` is one label below `shop.example`, so the host's `*.shop.example` certificate covers it.
- **The tenant** is read as `request.host.split('.')[0].replace('-tenants', '')`.
- **Precedence.** With `TELO_NEED_SITE__URL=https://shop.example` and a further `Telo.PublicUrl` at `https://admin.shop.example`, the exact host `admin.shop.example` reaches its own mount, and `acme-tenants.shop.example` reaches `tenant`.

### 8. Tenants on the operator's own wildcard domain

The manifest of example 6, unchanged.

- **Host:** the operator owns `shop.com`, so the host supplies `TELO_NEED_TENANTS__PATTERN=https://*.shop.com`, routes every match to `http`, and holds the certificate for `*.shop.com`.
- **Locally:** the same as example 6.

### 9. Customer domains

```yaml
needs:
  site:
    kind: Telo.PublicUrl
    parameters: { port: http, primary: true, customDomains: true }
  admin:
    kind: Telo.PublicUrl
    parameters: { port: http }
---
kind: Http.Server
metadata: { name: server }
port: !cel "ports.http"
mounts:
  - hostnames: [ !ref admin ]
    path: /
    mount: !ref admin
  - hostnames: [ !ref site ]
    path: /
    mount: !ref site
```

- **Host:**
  - A customer points `acme.com` at the application with a CNAME, and the operator attaches `acme.com` to `site`.
  - The host routes `acme.com` to `http` and holds its certificate.
  - The application is supplied only `site`'s and `admin`'s URLs.
- **Routing.**
  - `acme.com` matches no exact or pattern entry, so it reaches `site`, whose routes find the customer by `request.host` in the application's own data.
  - `admin.shop.example` still reaches `admin`.
- **Locally:** any host reaches `site`, such as `curl -H 'Host: acme.com' localhost:8080`.
- **A second `customDomains: true`** on `admin` fails `telo check` with `NEED_PARAMETERS_INVALID`.

### 10. Customer wildcard domains

The manifest of example 9, unchanged.

- **Host:** the operator attaches `*.acme.com` to `site`, and the host routes every match to `http`.
- **Routing:** `shop.acme.com` reaches `site` and is read through `request.host`.

### 11. A customer domain as the main address

The manifest of example 1, unchanged.

- **Host:** `TELO_NEED_SITE__URL=https://acme.com`, routed to `http`.
- The application reads `https://acme.com` as its address, and its links point there.

## Runners

- **k8s runner.**
  - It sets `TELO_HOST_PUBLIC_URL_TEMPLATE=https://{port}-<session id>.<base domain>` on a routed session.
  - It routes each host of a port's `publicUrls` that ends in `-<session id>.<base domain>`, beside the port's own host: added to the port's HTTPRoute `hostnames`, or as an Ingress rule per host. A host outside the session's suffix is not routed.
  - Patterns and `customDomains` come from the session's env, and the runner routes nothing for them.
- **Docker runner and local-process backend.** No template. Every address need comes from the session's env.

## Refusals

| Code | When |
|---|---|
| `NEED_PARAMETERS_INVALID` | a root address need naming no port, a key `ports:` does not hold, or a `udp` port; any parameter on a library's address need; more than one root `Telo.PublicUrl` with `primary: true`; more than one `Telo.PublicUrl` with `customDomains: true` on one port |
| `ERR_NEED_HOST_VALUE_INVALID` | a template that is not an `http`/`https` URL with only a host; a derived first label over 63 octets or starting with `-` |
| `ERR_MANIFEST_VALIDATION_FAILED` | an environment value for `pattern` outside the pattern grammar (the existing decode refusal) |
| `ERR_NEED_PUBLIC_URL_COLLISION` | two `Telo.PublicUrl` needs naming one port with the same host; two `Telo.PublicHostPattern` needs naming one port with the same literal suffix in the same form |
| `ERR_HOSTNAMES_PORT_MISMATCH` | a `hostnames` entry whose need names a port other than the server's |
| `REFERENCE_KIND_MISMATCH` | a `hostnames` entry referencing anything but an address need |
| `NEED_OPTIONAL_REFERENCED` | a `hostnames` entry referencing an optional need |
| `SCHEMA_VIOLATION` | an empty `hostnames`, or `baseUrl:` on an `Http.Server` |

## Releases

- **`requires:` floors.** Both types are kernel surface, so an application declaring one states `requires: telo:` at the release that ships it. `hostnames` is a field of `http-server`'s own schema and needs no floor of its own.
- **Release fragments.** `http-server` takes an `Added` fragment describing `hostnames`, `request.host`, precedence, the per-host OpenAPI document, the port check, and the removal of `baseUrl` with the closed schema. `http-dispatch` takes an `Added` fragment for `$defs/Hostnames`.
- **Changesets.** A changeset for every changed published package: the telo version line (sdk, kernel, analyzer, CLI), `@telorun/debug-wire` and `@telorun/runner-core` for `publicUrls`, and the k8s runner.

## Order of work

1. **Kernel and analyzer:** both types, their parameters and refusals, the address derivation, collisions, `publicUrls` on `Kernel.PortsResolved`, and the port number given to `ctx.resolveNeed`. The Rust kernel carries all of it in its needs parity slice.
2. **`http-server` and `http-dispatch`:** `hostnames`, the request's host, `request.host`, precedence, the port check, the per-host OpenAPI document, and the `baseUrl` removal with every in-repo manifest edited. Ships in the same release as step 1.
3. **Studio:** every `matcher` field of an entry.
4. **k8s runner:** routing `publicUrls`.
5. **Docs, for each step:**
   - `http-server`'s README and docs, with the scenario table, the examples and the not-an-access-boundary note;
   - `http-dispatch`'s README;
   - the need-types spec, with the label, derivation and pattern rules stated once;
   - the runner docs, with the host contract;
   - the authoring-agent primer and the hub's authoring guides;
   - `kernel/docs/modules.md`.

## Verify

- **Example 2.** Under `telo run` with `site=http://localhost:8080` and `admin=http://admin.localhost:8080`:
  - `admin.localhost:8080/users` is answered by `admin`;
  - `localhost:8080/users` is answered by `site`;
  - `/healthz` answers on both hosts and on `127.0.0.1:8080`;
  - a relative `Location` returned by an admin route reaches the client unchanged.
- **Patterns.** With example 6, `http://*.tenants.localhost:8080` routes `acme.tenants.localhost` and `a.b.tenants.localhost` to `tenant`, and `tenants.localhost` does not reach `tenant`. With `http://*-tenants.localhost:8080`, `acme-tenants.localhost` reaches `tenant` and `a.b-tenants.localhost` does not.
- **Precedence.** An exact entry, a pattern entry and an unrestricted mount that all register `GET /` each answer their own hosts. Between `*-tenants.shop.example` and `*.shop.example`, `acme-tenants.shop.example` reaches the first. Two mounts naming the same need with the same route fail server init.
- **Customer domains.** With example 9, `Host: acme.com` reaches `site`, `request.host` reads `acme.com`, and `Host: admin.localhost` still reaches `admin`.
- **Forwarded host.** With `trustProxy: true`, `X-Forwarded-Host: admin.localhost` selects the admin mount and is what `request.host` reads. Without trust, the same header changes nothing.
- **OpenAPI.** The document fetched on the admin host lists the admin and unrestricted routes only. Its `servers` entry is `/`, or the admin origin under trust.
- **No domain in a manifest.** A string `hostnames` entry fails `telo check`.
- **Port check.** Example 4 with `hostnames: [ !ref site ]` on `adminServer` refuses at creation with `ERR_HOSTNAMES_PORT_MISMATCH`, naming `site`, `http` and `admin`.
- **`baseUrl`.** An `Http.Server` with `baseUrl:` fails `telo check` with `SCHEMA_VIOLATION`, and every in-repo manifest passes `telo check`.
- **Derivation.**
  - With `TELO_HOST_PUBLIC_URL_TEMPLATE=https://{port}-s1.example.dev`, example 2's `site` reads `https://8080-s1.example.dev` and `admin` reads `https://admin--8080-s1.example.dev`. With `https://s1.example.dev`, `site` reads it bare.
  - A need whose derived label exceeds 63 octets is refused with `ERR_NEED_HOST_VALUE_INVALID`, naming it.
  - Example 6's `tenants` is not answered from the template, and is `ERR_NEED_UNMET` naming `TELO_NEED_TENANTS__PATTERN`.
- **Collisions.**
  - Example 2 with both URLs `http://localhost:8080` refuses the load with `ERR_NEED_PUBLIC_URL_COLLISION`, naming `site`, `admin`, `http` and `localhost`.
  - Two patterns `http://*.t.localhost` on one port are refused the same way.
- **Parameters.** Each of these fails `telo check` with `NEED_PARAMETERS_INVALID`:
  - two needs with `primary: true`;
  - two `customDomains: true` needs on one port;
  - any parameter on a library's address need.
- **k8s.** On a routed session of example 2, both hosts reach the pod, and a watch edit adding a third need routes its host with the pod unchanged.
- **Report.** `telo needs report -o json` lists each address need with its type, `port`, `primary` and `customDomains`, and the env name of its field.
- **Studio.** The mounts list shows `hostnames` beside `path`, and its picker offers the address needs.
