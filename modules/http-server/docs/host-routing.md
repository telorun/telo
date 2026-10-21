# Routing by host

One `Http.Server` can answer several addresses: a site and its admin address,
tenant subdomains, customers' own domains. The application declares each
address as a **need** and a mount names the needs it answers in `hostnames`,
so no domain name is ever written in the manifest. Whoever runs the
application supplies the addresses and routes their hosts to the port.

## The socket and the address

`listen:` is the socket the server binds:

```yaml
kind: Http.Server
metadata: { name: server }
listen:
  port: !cel "ports.http"       # required, a Telo.TcpPort
  address: 0.0.0.0              # the default
mounts:
  - path: /
    mount: !ref siteApi
```

- `listen.port` is required. `listen.address` defaults to `0.0.0.0`, which
  accepts connections from other machines — a container, a runner session or
  any proxy needs that, so leave it unset in an application. `127.0.0.1`
  accepts the same machine only, for a mock server inside a test.
- The top-level `port:` / `host:` spelling is refused by the resource rule
  `HTTP_SERVER_LISTEN_MOVED` (reported as `RESOURCE_RULE_VIOLATED`;
  `ERR_HTTP_SERVER_LISTEN_MOVED` when the server is created), naming
  `listen.port` / `listen.address`. There is no migration: edit the manifest.
- `baseUrl:` is gone. The server's schema is closed, so writing it is a
  `SCHEMA_VIOLATION`. An absolute link is built from the address need
  (`resources.site.url`), never from a fixed value.

The address a server is *reached* at is not its socket. It is a public address
need the application declares at its root, naming the port:

```yaml
ports:
  http: { env: PORT, default: 8080 }
needs:
  site:
    kind: Telo.PublicUrl
    parameters: { port: http, primary: true }
  tenants:
    kind: Telo.PublicHostPattern
    parameters: { port: http }
```

| Need type | Field | Parameters |
| --- | --- | --- |
| `Telo.PublicUrl` | `url`, an `http` / `https` origin — host and optional port, no path, query or credentials (`resources.site.url.host` is its host) | `port` (required at the root), `primary`, `customDomains` |
| `Telo.PublicHostPattern` | `pattern`, a pattern origin: `https://*.tenants.example`, `https://*-tenants.example` | `port` (required at the root) |

Both are declared by the kernel; their rules — supply through the root only,
the parameters, collisions, deriving an address from a host's template — are in
[Declaring a need](../../../docs/guides/declaring-a-need.md) and
[Providing needs](../../../docs/guides/providing-needs.md). A library declares
them with no parameters and its importer forwards a root need of its own.

## `hostnames`

A mount entry's `hostnames` is a list of at least one `!ref` to a
`Telo.PublicUrl` or `Telo.PublicHostPattern` need, beside `path`:

```yaml
mounts:
  - hostnames: [ !ref admin ]
    path: /
    mount: !ref adminApi
```

- A `Telo.PublicUrl` entry matches its URL's host exactly. With
  `customDomains: true`, it also matches every host no other entry of the
  server claims.
- A `Telo.PublicHostPattern` entry matches every host its pattern matches.
  `*.tenants.example` stands for one or more whole labels (`acme.tenants.example`,
  `a.b.tenants.example`, never `tenants.example`); `*-tenants.example` for a
  non-empty run of characters inside the first label (`acme-tenants.example`,
  never `a.b-tenants.example`).
- Hosts are matched case-insensitively, with the port and a trailing dot
  ignored.
- A mount without `hostnames` answers every host.
- The server applies a mount's `hostnames` to every route the mount registers,
  as it applies `path` — an `Http.Api`, `Http.Static`, `Http.Reference` or any
  other mount works unchanged.
- An editor and an outline of the application identify and label a mount by its
  `path` and its `hostnames` as written (`/ [!ref admin]`), so two mounts at `/`
  answering different addresses are told apart, whatever their order. A mount's
  `guard` is labelled by its mount.

What an entry may be is checked by `telo check`:

| Entry | Refusal |
| --- | --- |
| a string (`hostnames: [shop.example]`) | `INVALID_REFERENCE_FORM` — a domain name is never written in a manifest |
| a reference to anything but an address need | `REFERENCE_KIND_MISMATCH` |
| a reference to an optional need | `NEED_OPTIONAL_REFERENCED` |
| a reference to a fulfilment the module writes itself | `NEED_ROOT_SUPPLY_REQUIRED` |
| an empty list | `SCHEMA_VIOLATION` |

### The port check

Each need names a port, and a host routes the need's addresses to that port
only. A server holding an entry whose need names another port than the one it
listens on never sees those requests, so it refuses when it initializes with
`ERR_HOSTNAMES_PORT_MISMATCH`, naming the entry, the need's port and the
server's. The check runs at runtime only: the server's port is resolved at load
from the environment, the command line or a default.

## Precedence

For one request, the server considers three classes in order, and the first
class holding a route that matches the request's path and method answers:

1. mounts with an exact entry equal to the host;
2. mounts with a pattern entry matching the host, each pattern a class of its
   own, the longest literal suffix first (`*-tenants.shop.example` before
   `*.shop.example`);
3. mounts without `hostnames`, and — when no entry of the server claims the
   host — the mount naming the port's `customDomains` need.

The class is chosen before the path: a mount naming `site` with `GET
/users/{id}` answers `GET /users/me` on the site's host even beside an
unrestricted mount registering `GET /users/me`, which answers it on every other
host. Within a class, path matching decides as before. A request no route
matches reaches the server's not-found handler. Two mounts that can share a
class registering the same method and path — the same exact host, the same
pattern, or two that answer unclaimed hosts (unrestricted or `customDomains`) —
fail the server's initialization with `ERR_HTTP_ROUTE_DUPLICATE`, naming the
method, the path and both mounts.

## The request's host

The server derives one host per request and uses it for routing, the OpenAPI
origin, the access log and `request.host`:

- the `Host` header (`:authority` on HTTP/2), its port removed, lowercased, a
  trailing dot dropped;
- replaced by `X-Forwarded-Host` only when the server trusts the proxy in front
  — `trustProxy` set, or `trustForwardedHeaders: true`. Otherwise
  `X-Forwarded-Host` is ignored.

`request.host` is in every request context of the module: an `Http.Api` route's
`inputs`, `returns` and `catches`, a mount's `guard`, the server's `catches` and
`notFoundHandler`. A handler finds its tenant there, never in the raw header:

```yaml
inputs:
  tenant: !cel "request.host.split('.')[0]"
```

## A hostname is not an access boundary

Any client can send any `Host`. `hostnames` decides which routes a host reaches;
it does not stop a client from naming the admin host. A sub-tree that must be
protected is protected by its mount's [`guard`](mount-guard.md):

```yaml
  - hostnames: [ !ref admin ]
    path: /
    mount: !ref adminApi
    guard:
      invoke: !ref adminAuth
      inputs:
        authorization: !cel "request.headers.authorization"
```

## Refusing unknown hosts

`unknownHosts` is `serve` (the default) or `reject`.

- **`serve`** — a host no entry matches reaches the mounts without `hostnames`.
- **`reject`** — a request whose host matches no `hostnames` entry of any mount
  is answered `421 Misdirected Request` with the `{error: {code, message, data}}`
  envelope, code `ERR_HOST_NOT_SERVED`. The refusal comes before guards, routes
  and reading the body, and is the server's own answer: no `catches:` list sees
  it. Under trust, the host is the one `X-Forwarded-Host` names.
- **An IP-literal host is never refused** — IPv4, or bracketed IPv6. It reaches
  the mounts without `hostnames`, so a probe sent to the pod's own address keeps
  working, while a DNS-rebinding request, which carries a domain name, is still
  refused.

Two combinations are refused:

| Combination | Refusal |
| --- | --- |
| `reject` on a server none of whose mounts names `hostnames` — every non-IP request would be refused | the resource rule `HTTP_UNKNOWN_HOSTS_NO_HOSTNAMES` at `telo check`, `ERR_HTTP_UNKNOWN_HOSTS_NO_HOSTNAMES` when the server is created |
| `reject` on a server with a mount naming a `customDomains` need — a customer's domain may be any host | `ERR_HTTP_UNKNOWN_HOSTS_CUSTOM_DOMAINS` when the server initializes; runtime only, since `customDomains` is a parameter of the root need, possibly across an import |

## Custom domains

A `Telo.PublicUrl` with `customDomains: true` lets the host route further
domains to the need's port — a customer's `acme.com`, or `*.acme.com` — which
the application is never told about. The mount naming that need answers every
host no exact or pattern entry of the server claims, and its routes find the
customer through `request.host` in the application's own data. At most one such
need per port (`NEED_PARAMETERS_INVALID`).

## OpenAPI per host

The document an [`Http.Reference`](api-reference.md) serves lists exactly the
routes reachable on the host of the request that fetched it, under the
precedence above: those of the mounts naming that host, and of the mounts
without `hostnames`. Its `servers` entry is relative (`/`), or the request's own
origin under `trustProxy` / `trustForwardedHeaders: true`.

## Scenarios

| # | Scenario | The application declares | The host |
| --- | --- | --- | --- |
| 1 | One server, one address | one `Telo.PublicUrl` | routes its host to the port and supplies `url` |
| 2 | One server, a primary and secondary addresses | several `Telo.PublicUrl` on one port, one `primary`, one mount per need | gives each a distinct host and routes all of them to the port |
| 3 | Several servers, one address each | one `Telo.PublicUrl` per port | routes each host to its own port |
| 4 | Several servers, one with several addresses | rows 2 and 3 combined | as rows 2 and 3 |
| 5 | Several addresses, no primary | no `primary` | as row 2; whether a bare main address exists is its choice |
| 6 | Tenants on the host's own domain, `*.sub` form | a `Telo.PublicHostPattern` | supplies a `*.…` pattern it can serve and routes every match to the port |
| 7 | Tenants on the host's own domain, `*-sub` form | a `Telo.PublicHostPattern` | supplies a `*-…` pattern and routes as row 6; one label below its domain, so its wildcard certificate covers it |
| 8 | Tenants on the operator's own wildcard domain | a `Telo.PublicHostPattern` | supplies the operator's pattern, such as `https://*.shop.com`, and routes as row 6 |
| 9 | Customer domains | `customDomains: true` on one need of the port | routes each domain attached to the need to its port |
| 10 | Customer wildcard domains | as row 9 | as row 9, with a `*.` attachment |
| 11 | A customer domain as the main address | any `Telo.PublicUrl` | supplies the customer's URL as `url` |

In every row the application writes no domain name, and finds the tenant or
customer through `request.host`. Locally every row is environment values, with
`*.localhost` for patterns, since browsers resolve it to loopback. The k8s
runner derives `Telo.PublicUrl` addresses from its templates and serves rows
1–5; for rows 6–11, whoever writes the session's environment acts as the host
for those needs.

## Examples

In every example the routers (`siteApi`, `adminApi`, `tenantApi`, `healthApi`,
`statusApi`) are `Http.Api` resources declared elsewhere in the module, and
`adminAuth` an invocable checking a credential. A router is never named like a
need: a need shares the module's one namespace with its resources
(`DUPLICATE_RESOURCE_NAME`). The host's values are written for a host whose
domain is `shop.example`.

### 1. One server, one address

```yaml
kind: Telo.Application
metadata: { name: Shop, version: 1.0.0 }
requires: { telo: ">=0.118.0" }
imports:
  Http: oci://ghcr.io/telorun/http-server@0.38.0
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
listen:
  port: !cel "ports.http"
mounts:
  - path: /
    mount: !ref siteApi
```

- `site` is the only `Telo.PublicUrl`, so it is the primary. A server with one
  address needs no `hostnames`.
- **Host:** `TELO_NEED_SITE__URL=https://shop.example`, with `shop.example`
  routed to `http`.
- **k8s session:** `https://8080-<session>.<base>`, from the runner's template.
- **Locally:** `TELO_NEED_SITE__URL=http://localhost:8080`.

### 2. One server, a primary and a secondary address

```yaml
needs:
  site:
    kind: Telo.PublicUrl
    parameters: { port: http, primary: true }
  admin:
    kind: Telo.PublicUrl
    parameters: { port: http }
---
kind: Http.Server
metadata: { name: server }
listen:
  port: !cel "ports.http"
mounts:
  - path: /healthz
    mount: !ref healthApi
  - hostnames: [ !ref site ]
    path: /
    mount: !ref siteApi
  - hostnames: [ !ref admin ]
    path: /
    mount: !ref adminApi
    guard:
      invoke: !ref adminAuth
      inputs:
        authorization: !cel "request.headers.authorization"
```

- `healthApi` has no `hostnames`, so a probe sent to the pod's address reaches
  it on any host. `siteApi` and `adminApi` each answer only their own host: the
  admin routes are not reachable on the site host at any path.
- **Host:** `TELO_NEED_SITE__URL=https://shop.example`,
  `TELO_NEED_ADMIN__URL=https://admin.shop.example`, both routed to `http`.
- **k8s session:** `site` reads `https://8080-<session>.<base>`, `admin`
  `https://admin--8080-<session>.<base>`, which the runner routes.
- **Locally:** `TELO_NEED_SITE__URL=http://localhost:8080
  TELO_NEED_ADMIN__URL=http://admin.localhost:8080`. Setting both to
  `http://localhost:8080` refuses the load with `ERR_NEED_PUBLIC_URL_COLLISION`.
- **With `unknownHosts: reject`:** `Host: evil.example` is answered 421 with
  `ERR_HOST_NOT_SERVED`, while `/healthz` on `127.0.0.1:8080` still answers.

### 3. Several servers, one address each

```yaml
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
listen:
  port: !cel "ports.http"
mounts:
  - path: /
    mount: !ref siteApi
---
kind: Http.Server
metadata: { name: adminServer }
listen:
  port: !cel "ports.admin"
mounts:
  - path: /
    mount: !ref adminApi
    guard:
      invoke: !ref adminAuth
      inputs:
        authorization: !cel "request.headers.authorization"
```

- Each server has one address, so neither needs `hostnames`.
- **Host:** `TELO_NEED_SITE__URL=https://shop.example` routed to `http`,
  `TELO_NEED_ADMIN__URL=https://admin.shop.example` routed to `admin`.
- **k8s session:** each port has its own base, so each need is the only one on
  it: `https://8080-<session>.<base>` and `https://8081-<session>.<base>`.
- **Locally:** `http://localhost:8080` and `http://localhost:8081`. The hosts
  are equal and the ports differ, so this is not a collision.

### 4. Several servers, one with several addresses

Example 3 with a third need on port `admin`, and the admin server's mounts
restricted:

```yaml
needs:
  # site and admin as in example 3
  status:
    kind: Telo.PublicUrl
    parameters: { port: admin }
---
kind: Http.Server
metadata: { name: adminServer }
listen:
  port: !cel "ports.admin"
mounts:
  - hostnames: [ !ref status ]
    path: /
    mount: !ref statusApi
  - hostnames: [ !ref admin ]
    path: /
    mount: !ref adminApi
    guard:
      invoke: !ref adminAuth
      inputs:
        authorization: !cel "request.headers.authorization"
```

- **Host:** `admin.shop.example` and `status.shop.example`, both routed to
  `admin`.
- **k8s session:** `admin` and `status` share the base
  `https://8081-<session>.<base>` and neither is the primary, so both are
  derived: `https://admin--8081-<session>.<base>` and
  `https://status--8081-<session>.<base>`. The port's own host reaches no
  mount, since this server has no unrestricted one.
- `hostnames: [ !ref site ]` on `adminServer` refuses the server with
  `ERR_HOSTNAMES_PORT_MISMATCH`: `site` names `http`, and the server listens on
  `admin`.

### 5. Several addresses, no primary

Example 2 without `primary: true`.

- **Host:** both needs still get distinct hosts. Whether `shop.example` itself
  is routed, and to which need, is the host's choice.
- **k8s session:** both needs read a `<label>--` host, and the port's own host
  reaches only `healthApi`.

### 6. Tenants on the host's own domain, `*.sub` form

```yaml
needs:
  site:
    kind: Telo.PublicUrl
    parameters: { port: http, primary: true }
  tenants:
    kind: Telo.PublicHostPattern
    parameters: { port: http }
---
kind: Http.Server
metadata: { name: server }
listen:
  port: !cel "ports.http"
mounts:
  - hostnames: [ !ref tenants ]
    path: /
    mount: !ref tenantApi
  - hostnames: [ !ref site ]
    path: /
    mount: !ref siteApi
```

- `tenantApi`'s routes read the tenant as `request.host.split('.')[0]`.
  `siteApi` builds a tenant's link as
  `resources.tenants.pattern.replace('*', tenantId)`.
- **Host:** `TELO_NEED_TENANTS__PATTERN=https://*.tenants.shop.example`, every
  match routed to `http`.
- **Locally:** `TELO_NEED_TENANTS__PATTERN=http://*.tenants.localhost:8080`, so
  `http://acme.tenants.localhost:8080` reaches `tenantApi`.
- **k8s session:** the template never answers a pattern, so the session's
  environment sets it, or the load is `ERR_NEED_UNMET` naming
  `TELO_NEED_TENANTS__PATTERN`.

### 7. Tenants on the host's own domain, `*-sub` form

The manifest of example 6.

- **Host:** `TELO_NEED_TENANTS__PATTERN=https://*-tenants.shop.example`.
  `acme-tenants.shop.example` is one label below `shop.example`, so the host's
  `*.shop.example` certificate covers it.
- The tenant is `request.host.split('.')[0].replace('-tenants', '')`.
- With a further `Telo.PublicUrl` at `https://admin.shop.example`, the exact
  host `admin.shop.example` reaches its own mount and
  `acme-tenants.shop.example` reaches `tenantApi`.

### 8. Tenants on the operator's own wildcard domain

The manifest of example 6. The operator owns `shop.com`, so the host supplies
`TELO_NEED_TENANTS__PATTERN=https://*.shop.com`, routes every match to `http`
and holds the `*.shop.com` certificate.

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
listen:
  port: !cel "ports.http"
mounts:
  - hostnames: [ !ref admin ]
    path: /
    mount: !ref adminApi
  - hostnames: [ !ref site ]
    path: /
    mount: !ref siteApi
```

- **Host:** a customer points `acme.com` at the application, the operator
  attaches it to `site`, and the host routes it to `http` and holds its
  certificate. The application is supplied only `site`'s and `admin`'s URLs.
- **Routing:** `acme.com` matches no exact or pattern entry, so it reaches
  `siteApi`, whose routes find the customer by `request.host`.
  `admin.shop.example` still reaches `adminApi`.
- **Locally:** any host reaches `siteApi` —
  `curl -H 'Host: acme.com' localhost:8080`.
- A second `customDomains: true` on `admin` fails `telo check` with
  `NEED_PARAMETERS_INVALID`.

### 10. Customer wildcard domains

The manifest of example 9. The operator attaches `*.acme.com` to `site`, and
`shop.acme.com` reaches `siteApi`, read through `request.host`.

### 11. A customer domain as the main address

The manifest of example 1, with `TELO_NEED_SITE__URL=https://acme.com` routed
to `http`. The application reads `https://acme.com` as its address, and its
links point there.
