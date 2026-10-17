# Public URLs

An application declares every address it is reached at as a need: a single address as `Telo.PublicUrl`, a family of tenant hosts as `Telo.PublicHostPattern`. Several may name one port. An `Http.Server` mount names the needs it answers, so the application never writes a domain name, and the request's host selects the mount. Whoever runs the application — a runner, Telo Cloud, any other host — reads the needs from `telo needs report`, supplies each, and routes its hosts to the port with the host and path unchanged. `Http.Server.baseUrl` is removed.

## Before / After

- **Before.** The `Telo.PublicUrl` type is planned with only a `port` parameter, and its template must contain `{port}`. `Http.Server` matches mounts by path only and advertises one fixed `baseUrl`. A tenant subdomain or a customer's own domain has no declaration at all.
- **After.**
  - `Telo.PublicUrl` has `port`, `primary` and `customDomains`.
  - `Telo.PublicHostPattern` declares tenant hosts in both `*.sub.domain.com` and `*-sub.domain.com` form.
  - An `Http.Server` mount restricts the hosts it answers with `hostnames`, a list of references to those needs.
  - A server may opt in to refusing every host none of its mounts names, with `unknownHosts: reject`.
  - The socket a server binds is `listen: { address, port }`, replacing the top-level `host` and `port`.
  - Every scenario in the table below is expressible by the application and servable by a host implementing the contract's report mode.

## Address needs

Both types are kernel-declared need types. A library declares them with no parameters, having no `ports:` of its own. The root declares its own, naming a port, and forwards it at the import.

### Supplied only through a root need

The port, `primary` and `customDomains` are parameters of a root need, so an address that does not come through one would have no port check, no collision group, no `publicUrls` entry and no `customDomains` behaviour, and a literal fulfilment would put a domain name in the manifest.

- **`supply: root`.** `Telo.NeedType` gains an optional key `supply`, whose only value is `root`. A need of such a type is fulfilled only through a root need, forwarded whole. Both address types declare it.
- **What is refused.** `NEED_ROOT_SUPPLY_REQUIRED` at `telo check`, from the need table, and `ERR_NEED_ROOT_SUPPLY_REQUIRED` at load. The message names which case it is:
  - a self-supplied fulfilment of the type;
  - a field-by-field supply of one at an import;
  - a library's need of the type that reaches the root without being forwarded, which would otherwise be read from `TELO_NEED_<LIBRARY>__<NEED>__URL`.
- **Started applications.** An application started with `App.Instance` is a root of its own: its address needs are read from its own environment, and the parent's host values are not passed to it.
- **No floor.** Only kernel-declared types use the key, so no module needs a `requires:` floor for it.

### `Telo.PublicUrl`

One address.

| Parameter | Meaning |
|---|---|
| `port` | A key of the root's `ports:` naming a `tcp` port. Required at the root. |
| `primary` | `true` marks the application's main address. Default `false`. |
| `customDomains` | `true` lets the host route further domains to this need's port, ones the application is never told about. Default `false`. |

- **The field** is `url`, a `Telo.Url`, and its host is `resources.<need>.url.host`. It is an origin: `http` or `https`, a host, an optional port, and no path, query, fragment or credentials. The field's `Telo.Url` type constrains those members through the type's member parameters — `scheme: { enum: [http, https] }`, `path: { enum: ["/"] }`, and `{ not: {} }` for `query`, `user` and `password`, which the refusal words as "it must have no <member>" — so any other value is refused at load as a field that does not decode (`ERR_MANIFEST_VALIDATION_FAILED`). `Telo.Url` gains the `user`, `password`, `path` and `query` parameters for this, beside `scheme`.
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

At load, before any resource initializes, two address needs are refused with `ERR_NEED_PUBLIC_URL_COLLISION` when any of these holds:

- **On one port,** two `Telo.PublicUrl` URLs have the same host, or two `Telo.PublicHostPattern` patterns have the same literal suffix in the same form. Matching ignores the port, so the server could not tell them apart.
- **On two different ports,** two URLs, or two patterns, have the same host or suffix and the same effective port. The effective port is the explicit one, or the scheme's default (80 for `http`, 443 for `https`). No host can route one hostname and port to two ports.

The refusal names both needs, their ports and the host or pattern. This is a runtime refusal only, because the values come from the environment. Needs on different ports may share a host on different effective ports, as `localhost:8080` and `localhost:8081` do locally. An exact host that a pattern on the same port also matches is not a collision: precedence decides.

### Deriving addresses from the template

Two host values answer `Telo.PublicUrl` needs, and nothing else. Each is an `http` or `https` origin, with `{port}` optional in its host:

- `TELO_HOST_PUBLIC_URL_TEMPLATE`, the main template, which must not contain `{label}`;
- `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE`, whose host must also contain `{label}`.

A value outside this shape is `ERR_NEED_HOST_VALUE_INVALID`. The templates are read only when the root declares a `Telo.PublicUrl`. The host states its own naming in the two templates, and the kernel decides only which need gets the main one:

1. **The label.** Each need has a label: its name lowercased, with `_` written as `-`. `admin` is `admin`, `admin_api` is `admin-api`.
2. **The base.** A need's base is the main template with `{port}` replaced by its port's number. A main template without `{port}` is one base for every need.
3. **Who gets the main template.** Among the needs sharing a base, the primary gets the base. When no primary shares it, the only need sharing it gets it.
4. **Everyone else** gets the secondary template with `{label}` and `{port}` replaced. With no secondary template set, those needs are not answered, and are `ERR_NEED_UNMET` unless their env name supplies them.
5. **Invalid labels.** A derived first label over 63 octets, or one starting or ending with `-`, is `ERR_NEED_HOST_VALUE_INVALID`. The refusal names `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE` and the need.

The k8s runner sets `https://{port}-<session>.<base>` and `https://{label}--{port}-<session>.<base>`, so example 2's `admin` reads `https://admin--8080-<session>.<base>`. The derived host keeps the base's number of labels, so the runner's wildcard certificate covers it. Derived addresses are subject to the collision rules like any others.

### Announced to runners

Each port entry of `Kernel.PortsResolved` gains `publicUrls: [{ need, host }]`, present when a `Telo.PublicUrl` need names that port, with the host its URL resolved to. The event is re-emitted on every load. A runner that reads the event tolerantly ignores the field until it is updated. A port an address need names counts as used, so it draws no `UNUSED_DECLARATION`; `telo needs report` lists the kernel-declared types under `type.module: Telo`, and a `Telo.PublicUrl`'s `url` is not marked sensitive, since its type forbids a password.

## `Http.Server` host routing

### `hostnames` on a mount

A mount entry gains `hostnames`, a list of at least one reference to a `Telo.PublicUrl` or `Telo.PublicHostPattern` need, beside `path`.

- **What an entry matches.**
  - A `Telo.PublicUrl` entry matches its URL's host, exactly.
  - A `Telo.PublicHostPattern` entry matches its pattern.
  - A `Telo.PublicUrl` with `customDomains: true` also matches every host that no exact or pattern entry of the server claims.
- **What an entry may be.** Only a reference: a domain name cannot be written in a manifest.
  - A string entry is refused at `telo check` with `INVALID_REFERENCE_FORM`.
  - A reference to anything but those two need types is `REFERENCE_KIND_MISMATCH`.
  - A reference to an optional need is `NEED_OPTIONAL_REFERENCED`.
  - A reference to a self-supplied fulfilment is `NEED_ROOT_SUPPLY_REQUIRED`.
- **Unrestricted mounts.** A mount without `hostnames` answers every host.
- **The port check.** A controller resolving one of these needs through `ctx.resolveNeed` (`Need.Resolve`, whose response gains an optional `port`, 1–65535, in generation `telo-6`, which no carrier speaks yet) also receives the number of the port the need names. A server holding an entry whose need names a port other than the one it listens on refuses when it initializes with `ERR_HOSTNAMES_PORT_MISMATCH` — the server opens its `hostnames` needs in `init()`. The refusal names the need, its port and the server's port. It is deliberately runtime-only: the server's port is resolved at load from env, argv or a default, so a static check could compare only the spelling `ports.<key>`, which would mean one module reading CEL text.
- **Applied to every route.** The server applies a mount's `hostnames` to every route the mount registers, as it applies `path`. `Http.Api`, `Http.Static`, `Http.Reference`, `Mcp.HttpEndpoint` and `UiReact.App` are unchanged.
- **Annotations.**
  - The field carries `x-telo-topology-role: matcher`, as `path` does.
  - Its item schema is `$defs/Hostname` on the `HttpDispatch.Request` carrier, referenced through `x-telo-schema-from`, so any HTTP transport reads the same matcher with the same meaning.
- **Not an access boundary.** Any client can send any `Host`, so `hostnames` only routes. A sub-tree that must be protected is protected by its mount's `guard`, and the docs say so.

### The request's host

The server derives one host per request, and uses it for routing, the OpenAPI origin, the access log and `request.host`:

- the `Host` header, or `:authority` on HTTP/2, with the port removed, lowercased, and a trailing dot ignored;
- replaced by `X-Forwarded-Host` only when `trustProxy` is set or `trustForwardedHeaders` is `true`; otherwise `X-Forwarded-Host` is ignored.

`request.host` is added to the CEL context of `Http.Api` routes, their `catches:`, and mount `guard` inputs. A handler then reads the trusted host, and finds its tenant there, rather than reading the raw header.

### Precedence

For one request, the server considers three classes in order. The first class holding a route that matches the request's path and method answers — the class is chosen before the path, so a more specific path in a later class never wins over a route of an earlier one:

1. mounts with an exact entry equal to the host;
2. mounts with a pattern entry matching the host, each pattern a class of its own, longest literal suffix first;
3. unrestricted mounts, and the mount naming the port's `customDomains` need when no entry of the server claims the host.

Within one class the existing path matching decides. A request matching no route reaches the server's not-found handler. Two mounts that can share a class registering the same method and path — the same exact host, the same pattern, or two answering unclaimed hosts (unrestricted or `customDomains`) — fail server init with `ERR_HTTP_ROUTE_DUPLICATE`, naming the method, the path and both mounts.

### Refusing unknown hosts

`Http.Server.unknownHosts` is `serve` (default) or `reject`. It is an enum rather than a boolean, so a further treatment can be added as a value.

- **`serve`.** A host no entry matches reaches the unrestricted mounts, as above.
- **`reject`.** A request whose host matches no `hostnames` entry of any of the server's mounts is answered `421 Misdirected Request`.
  - The body is the `{error: {code, message, data}}` envelope with code `ERR_HOST_NOT_SERVED`.
  - The refusal comes before guards, routes and reading the body, and is the server's own answer: no `catches:` list sees it.
  - The host is the one the server derives, so `X-Forwarded-Host` counts under trust.
- **IP-literal hosts are never refused,** IPv4 or bracketed IPv6. They reach only unrestricted mounts, so a probe sent to the pod's address keeps working. DNS rebinding is still blocked, because a rebinding request carries the attacker's domain name, not an IP.
- **Two refused combinations.**
  - `reject` on a server whose mounts carry no `hostnames`: every non-IP request would be refused. Declared in `Http.Server`'s `x-telo-resource-rules` as `HTTP_UNKNOWN_HOSTS_NO_HOSTNAMES`, and twinned in its controller at creation as `ERR_HTTP_UNKNOWN_HOSTS_NO_HOSTNAMES`. The rule reads only the server's own mounts, and only whether each carries the key: a presence test `has(a.b)` in a resource or referrer rule condition reads `a`'s keys and no value, so a `hostnames` list of references does not skip the rule as a read of a dynamic value would.
  - `reject` on a server with a mount naming a `customDomains` need: any host may be a customer's there. Refused when the server initializes with `ERR_HTTP_UNKNOWN_HOSTS_CUSTOM_DOMAINS`, deliberately runtime-only. `customDomains` is a parameter of the outermost need, possibly across an import, and a resource rule's `resolve:` reads resource declarations, not needs. A server inside a library also cannot know the root's need when the library is analysed alone.

### OpenAPI

The document an `Http.Reference` serves lists exactly the routes reachable on the host of the request that fetched it, under the precedence above. Its `servers` entry is relative (`/`). With `trustProxy` set or `trustForwardedHeaders: true`, it is the request's own origin.

### `baseUrl` is removed

- `Http.Server.baseUrl` is removed with no replacement. It also leaves the `<name>.Listening` event payload.
- Its one use was the OpenAPI `servers` entry, which the rule above answers correctly on every host. A fixed value would be right on at most one host.
- A route that builds an absolute link reads `resources.<need>.url`, or replaces `*` in `resources.<need>.pattern`.
- The `Http.Server` schema becomes closed (`additionalProperties: false`), so a manifest still writing `baseUrl:` fails with `SCHEMA_VIOLATION` rather than being ignored.
- There is no migration entry, since nothing is equivalent. Every in-repo manifest setting it on an `Http.Server` is edited.

### `listen` replaces `host` and `port`

The socket the server binds is declared under one key, because "host" now means the request's host everywhere else on the kind.

- **The block.** `listen` is required, with two fields:
  - `listen.port` is required, a `Telo.TcpPort`;
  - `listen.address` defaults to `0.0.0.0` and carries the current `host` description: other machines can connect, which a container, a runner session or any proxy requires, while `127.0.0.1` accepts the same machine only, for a mock server inside a test.
- **Room to grow.** A later socket option, such as a Unix socket path, goes under `listen:`, and a future server kind of another transport reuses the same block.
- **Events and logs.** The `<name>.Listening` event payload carries `address` and `port` in place of `host` and `port`. The listening log record keeps `server.address` / `server.port`.
- **The old spelling is refused, not migrated.** The manifest migration format has no module-owned entries and no operation that moves a key into a new mapping. So:
  - the schema keeps `host` and `port` declared, `deprecated: true` and carrying nothing else, so the key is not reported as unknown;
  - a resource rule on `Http.Server` reports `HTTP_SERVER_LISTEN_MOVED`, naming the replacement (`port` is now `listen.port`, `host` is now `listen.address`). Its controller twin at creation is `ERR_HTTP_SERVER_LISTEN_MOVED`;
  - a manifest that writes the old spelling and no `listen:` is also a `SCHEMA_VIOLATION` for the missing required `listen`.
- **In-repo manifests.** Every one declaring an `Http.Server` is edited.

### Studio

The topology entry list renders every `matcher` field of an entry, `hostnames` and `path`, read from `x-telo-topology-role` with no kind-specific code. `hostnames` is edited through the reference picker, which offers the module's own declarations — its needs and a library's `resources:` inputs, the declarations the analyzer synthesizes for those blocks — beside its resources, filtered by the slot's kind like any candidate.

## The host contract

What any host serving an application's addresses does. The runner docs state it once, and Telo Cloud is held to it like any other host. A host serves an application in one of two modes.

### Report mode

The host reads the needs and supplies every one. Every scenario below is servable in this mode.

1. **Reads the needs from `telo needs report -o json`.** For each address need that gives its type, `port`, `primary` and `customDomains`, and the env name of its field. Nothing else about the application is read.
2. **Gives each `Telo.PublicUrl` a URL** that collides with no other, routes its host to the port, and supplies `url`. `primary` marks the need the host gives its main address. How the host names addresses is its own choice.
3. **Gives each `Telo.PublicHostPattern` a pattern** in either form that collides with no other. It routes every host matching the pattern to the port, and supplies `pattern`.
4. **May route further domains to the port of a `customDomains` need,** exact or `*.` wildcards. It supplies nothing for them.

### Template mode

The host states its naming, the kernel derives each address, and the host follows what the kernel announces.

1. **Sets `TELO_HOST_PUBLIC_URL_TEMPLATE`,** and `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE` when it can serve several addresses on one port. It reads nothing about the application before boot.
2. **Routes each host announced in the `publicUrls` of `Kernel.PortsResolved` to its port,** again on every load.
3. **Answers `Telo.PublicUrl` only.** Patterns and `customDomains` are outside this mode, so a template-mode host is a partial host. Whoever supplies such a need through env acts as the host for it.

### Both modes

- **Routes without changing the request.** Every route delivers to the port with the path unchanged and `Host` as the client sent it. A host never routes one hostname and port to two ports.
- **Supplies origins.** A `url` is an origin, and a `pattern` a pattern origin.
- **Owns TLS, certificates and DNS.** The application holds no certificate and registers nothing. It learns of a domain only through a fulfilment.
- **May redirect a domain instead of routing it.** The application never sees a redirected request.
- **Leaves unsupplied any need it cannot serve.** The load is then `ERR_NEED_UNMET`, naming the env name.

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

In every row the application writes no domain name, and the tenant or customer is found through `request.host`. Locally every row is env values, with `*.localhost` for patterns, since browsers resolve it to loopback. The k8s runner is a template-mode host. It serves rows 1–5; for rows 6–11, whoever writes the session's env acts as the host for those needs, and the runner routes nothing for them.

## Examples

Assumptions used in every example:
- The routers (`siteApi`, `adminApi`, `tenantApi`, `healthApi`, `statusApi`) are `Http.Api` resources declared elsewhere in the module, and `adminAuth` an invocable checking a credential. A router is never named like a need: a need shares the module's one namespace with its resources.
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
listen:
  port: !cel "ports.http"
mounts:
  - path: /
    mount: !ref siteApi
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

- **Routing.**
  - `healthApi` is unrestricted, so a probe sent to the pod's address reaches it on any host.
  - `siteApi` and `adminApi` each answer only their own host, and the admin routes are not reachable on the site host at any path.
- **Host:** `TELO_NEED_SITE__URL=https://shop.example` and `TELO_NEED_ADMIN__URL=https://admin.shop.example`, both routed to `http`.
- **k8s session:**
  - `site` reads `https://8080-<session>.<base>`.
  - `admin` reads `https://admin--8080-<session>.<base>`, which the runner routes from `publicUrls`.
- **Locally:** `TELO_NEED_SITE__URL=http://localhost:8080 TELO_NEED_ADMIN__URL=http://admin.localhost:8080`. Setting both to `http://localhost:8080` refuses the load with `ERR_NEED_PUBLIC_URL_COLLISION`.
- **With `unknownHosts: reject` on the server:** `Host: evil.example` is answered 421 with `ERR_HOST_NOT_SERVED`, while `/healthz` on `127.0.0.1:8080` still answers.

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

- **Host:** `admin.shop.example` and `status.shop.example`, both routed to `admin`.
- **k8s session:** `admin` and `status` share the base `https://8081-<session>.<base>`, and neither is the primary, so both are derived.
  - `admin` reads `https://admin--8081-<session>.<base>`.
  - `status` reads `https://status--8081-<session>.<base>`.
  - The port's own host reaches no mount, since this server has no unrestricted one.
- **`hostnames: [ !ref site ]` on `adminServer`** refuses the server at its init with `ERR_HOSTNAMES_PORT_MISMATCH`: `site` names `http`, and the server listens on `admin`.

### 5. Several addresses, no primary

Example 2 without `primary: true`.

- **Host:** both needs still get distinct hosts. Whether `shop.example` itself is routed, and to which need, is the host's choice. The application only learns the two URLs it is given.
- **k8s session:** both needs read a `<label>--` host. The port's own host reaches only `healthApi`.

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

- **Routing.** `tenantApi`'s routes read the tenant as `request.host.split('.')[0]`. `siteApi` builds a tenant's link as `resources.tenants.pattern.replace('*', tenantId)`.
- **Host:** `TELO_NEED_TENANTS__PATTERN=https://*.tenants.shop.example`, with every match routed to `http`.
- **Locally:** `TELO_NEED_TENANTS__PATTERN=http://*.tenants.localhost:8080`, so `http://acme.tenants.localhost:8080` reaches `tenantApi`.
- **k8s session:** the template does not answer it, so the session's env sets it or the load is `ERR_NEED_UNMET` naming `TELO_NEED_TENANTS__PATTERN`.

### 7. Tenants on the host's own domain, `*-sub` form

The manifest of example 6, unchanged.

- **Host:** `TELO_NEED_TENANTS__PATTERN=https://*-tenants.shop.example`. `acme-tenants.shop.example` is one label below `shop.example`, so the host's `*.shop.example` certificate covers it.
- **The tenant** is read as `request.host.split('.')[0].replace('-tenants', '')`.
- **Precedence.** With `TELO_NEED_SITE__URL=https://shop.example` and a further `Telo.PublicUrl` at `https://admin.shop.example`, the exact host `admin.shop.example` reaches its own mount, and `acme-tenants.shop.example` reaches `tenantApi`.

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

- **Host:**
  - A customer points `acme.com` at the application with a CNAME, and the operator attaches `acme.com` to `site`.
  - The host routes `acme.com` to `http` and holds its certificate.
  - The application is supplied only `site`'s and `admin`'s URLs.
- **Routing.**
  - `acme.com` matches no exact or pattern entry, so it reaches `siteApi`, whose routes find the customer by `request.host` in the application's own data.
  - `admin.shop.example` still reaches `adminApi`.
- **Locally:** any host reaches `siteApi`, such as `curl -H 'Host: acme.com' localhost:8080`.
- **A second `customDomains: true`** on `admin` fails `telo check` with `NEED_PARAMETERS_INVALID`.

### 10. Customer wildcard domains

The manifest of example 9, unchanged.

- **Host:** the operator attaches `*.acme.com` to `site`, and the host routes every match to `http`.
- **Routing:** `shop.acme.com` reaches `siteApi` and is read through `request.host`.

### 11. A customer domain as the main address

The manifest of example 1, unchanged.

- **Host:** `TELO_NEED_SITE__URL=https://acme.com`, routed to `http`.
- The application reads `https://acme.com` as its address, and its links point there.

## Runners

- **k8s runner.**
  - A template-mode host. On a routed session it sets `TELO_HOST_PUBLIC_URL_TEMPLATE=https://{port}-<session id>.<base domain>` and `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE=https://{label}--{port}-<session id>.<base domain>`.
  - It routes each host of a port's `publicUrls` that ends in `-<session id>.<base domain>`, beside the port's own host: added to the port's HTTPRoute `hostnames`, or as an Ingress rule per host. A host outside the session's suffix is not routed, nor one that is any session port's own host (an all-digit label), so one hostname never reaches two ports.
  - It is a partial host. A pattern or `customDomains` need comes from the session's env, whose author acts as its host, and the runner routes nothing for it.
  - A one-shot run sets only the main template, since nothing republishes its routes, so it answers each port's primary — or only — address, and every other `Telo.PublicUrl` comes from the session's env.
- **Docker runner and local-process backend.** No template. Every address need comes from the session's env.

## Refusals

| Code | When |
|---|---|
| `NEED_PARAMETERS_INVALID` | a root address need naming no port, a key `ports:` does not hold, or a `udp` port; any parameter on a library's address need; more than one root `Telo.PublicUrl` with `primary: true`; more than one `Telo.PublicUrl` with `customDomains: true` on one port |
| `NEED_ROOT_SUPPLY_REQUIRED` / `ERR_NEED_ROOT_SUPPLY_REQUIRED` | an address need supplied other than through a root need: a self-supplied fulfilment, a field-by-field supply at an import, or a library need reaching the root unforwarded |
| `ERR_NEED_HOST_VALUE_INVALID` | a template that is not an `http`/`https` origin; a secondary template without `{label}`; a derived first label over 63 octets or starting or ending with `-` |
| `ERR_MANIFEST_VALIDATION_FAILED` | an environment value for `url` that is not an origin, or for `pattern` outside the pattern grammar (the existing decode refusal) |
| `ERR_NEED_PUBLIC_URL_COLLISION` | on one port, two URLs with the same host or two patterns with the same suffix and form; on two ports, the same host or pattern on the same effective port |
| `ERR_HOSTNAMES_PORT_MISMATCH` | a `hostnames` entry whose need names a port other than the server's (runtime only, at the server's init) |
| `ERR_HTTP_ROUTE_DUPLICATE` | two mounts of one precedence class registering the same method and path for the same host or pattern (at the server's init) |
| `REFERENCE_KIND_MISMATCH` | a `hostnames` entry referencing anything but an address need |
| `NEED_OPTIONAL_REFERENCED` | a `hostnames` entry referencing an optional need |
| `SCHEMA_VIOLATION` | an empty `hostnames`; `baseUrl:` on an `Http.Server`; an `Http.Server` with no `listen:` |
| `INVALID_REFERENCE_FORM` | a string `hostnames` entry |
| `HTTP_SERVER_LISTEN_MOVED` / `ERR_HTTP_SERVER_LISTEN_MOVED` | `host:` or `port:` on an `Http.Server`, naming `listen.address` / `listen.port` |
| `HTTP_UNKNOWN_HOSTS_NO_HOSTNAMES` / `ERR_HTTP_UNKNOWN_HOSTS_NO_HOSTNAMES` | `unknownHosts: reject` on a server whose mounts carry no `hostnames` |
| `ERR_HTTP_UNKNOWN_HOSTS_CUSTOM_DOMAINS` | `unknownHosts: reject` on a server with a mount naming a `customDomains` need (runtime only, at the server's init) |
| `ERR_HOST_NOT_SERVED` | the 421 answer's envelope code, for a request whose host no entry matches under `unknownHosts: reject` |

## Releases

- **`requires:` floors.** Both types are kernel surface, so an application declaring one states `requires: telo:` at the release that ships it. `http-server` and `http-dispatch` declare no floor: `hostnames`, `listen` and `$defs/Hostname` are fields of their own schemas, and the previous published CLI reads both modules cleanly, verified by execution.
- **Release fragments.** `http-server` takes an `Added` fragment describing `hostnames`, `request.host`, precedence, the per-host OpenAPI document, the port check, `unknownHosts`, `listen` replacing `host` / `port`, and the removal of `baseUrl` with the closed schema. The fragment states that every `Http.Server` must be edited. `http-dispatch` takes an `Added` fragment for `$defs/Hostname` and the hostname helpers.
- **Changesets.** A changeset for every changed published package: the telo version line (sdk, templating, analyzer, kernel), `@telorun/debug-wire` and `@telorun/runner-core` for `publicUrls`, and the k8s runner.

## Order of work

1. **Kernel and analyzer:** both types, their parameters and refusals, `supply: root` on `Telo.NeedType` with `NEED_ROOT_SUPPLY_REQUIRED`, the origin constraint on `url`, the two templates and the address derivation, collisions, `publicUrls` on `Kernel.PortsResolved`, and the port number given to `ctx.resolveNeed`. The Rust kernel carries all of it in its needs parity slice.
2. **`http-server` and `http-dispatch`:** `hostnames`, the request's host, `request.host`, precedence, the port check, `unknownHosts` with its two rules, the per-host OpenAPI document, `listen` with `HTTP_SERVER_LISTEN_MOVED`, and the `baseUrl` removal, with every in-repo manifest edited. Ships in the same release as step 1.
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
  - `admin.localhost:8080/users` is answered by `adminApi`;
  - `localhost:8080/users` is answered by `siteApi`;
  - `/healthz` answers on both hosts and on `127.0.0.1:8080`;
  - a relative `Location` returned by an admin route reaches the client unchanged.
- **Patterns.** With example 6, `http://*.tenants.localhost:8080` routes `acme.tenants.localhost` and `a.b.tenants.localhost` to `tenantApi`, and `tenants.localhost` does not reach `tenantApi`. With `http://*-tenants.localhost:8080`, `acme-tenants.localhost` reaches `tenantApi` and `a.b-tenants.localhost` does not.
- **Precedence.** An exact entry, a pattern entry and an unrestricted mount that all register `GET /` each answer their own hosts. Between `*-tenants.shop.example` and `*.shop.example`, `acme-tenants.shop.example` reaches the first. Two mounts naming the same need with the same route fail server init.
- **Customer domains.** With example 9, `Host: acme.com` reaches `siteApi`, `request.host` reads `acme.com`, and `Host: admin.localhost` still reaches `adminApi`.
- **Unknown hosts.**
  - Example 2 with `unknownHosts: reject` answers `Host: evil.example` with 421 and `ERR_HOST_NOT_SERVED`, without invoking `adminAuth` or reading the body.
  - It still answers `/healthz` on `127.0.0.1:8080` and `[::1]:8080`.
  - Example 1 with `unknownHosts: reject` fails `telo check` with `HTTP_UNKNOWN_HOSTS_NO_HOSTNAMES`.
  - A consumer whose `telo check` is skipped fails at creation with `ERR_HTTP_UNKNOWN_HOSTS_NO_HOSTNAMES`.
  - Example 9 with it fails at the server's init with `ERR_HTTP_UNKNOWN_HOSTS_CUSTOM_DOMAINS`.
- **Forwarded host.** With `trustProxy: true`, `X-Forwarded-Host: admin.localhost` selects the admin mount and is what `request.host` reads. Without trust, the same header changes nothing.
- **OpenAPI.** The document fetched on the admin host lists the admin and unrestricted routes only. Its `servers` entry is `/`, or the admin origin under trust.
- **No domain in a manifest.** A string `hostnames` entry fails `telo check` with `INVALID_REFERENCE_FORM`.
- **Root supply.** Each of these fails `telo check` with `NEED_ROOT_SUPPLY_REQUIRED`, naming its case, and the load with `ERR_NEED_ROOT_SUPPLY_REQUIRED`:
  - a self-supplied `Telo.PublicUrl` fulfilment referenced from `hostnames`;
  - a library's `Telo.PublicUrl` supplied field by field at its import;
  - a library's `Telo.PublicUrl` the root does not forward.

- **Origins.** `TELO_NEED_SITE__URL=https://shop.example/app` refuses the load with `ERR_MANIFEST_VALIDATION_FAILED`, naming the variable.
- **Port check.** Example 4 with `hostnames: [ !ref site ]` on `adminServer` refuses at the server's init with `ERR_HOSTNAMES_PORT_MISMATCH`, naming `site`, `http` and `admin`.
- **`baseUrl`.** An `Http.Server` with `baseUrl:` fails `telo check` with `SCHEMA_VIOLATION`, and every in-repo manifest passes `telo check`.
- **`listen`.**
  - `listen: { port: 8080 }` listens on `0.0.0.0:8080`, and `listen: { address: 127.0.0.1, port: 8080 }` on loopback only.
  - The `<name>.Listening` event carries `address` and `port`.
  - An `Http.Server` with `port: 8080` fails `telo check` with `HTTP_SERVER_LISTEN_MOVED` naming `listen.port`, and with `host:` naming `listen.address`. A consumer whose check is skipped fails at creation with `ERR_HTTP_SERVER_LISTEN_MOVED`.
- **Derivation.**
  - With `TELO_HOST_PUBLIC_URL_TEMPLATE=https://{port}-s1.example.dev` and `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE=https://{label}--{port}-s1.example.dev`, example 2's `site` reads `https://8080-s1.example.dev` and `admin` reads `https://admin--8080-s1.example.dev`. With a main template of `https://s1.example.dev`, `site` reads it bare.
  - With no secondary template, example 2's `admin` is `ERR_NEED_UNMET` naming `TELO_NEED_ADMIN__URL`, and a secondary template without `{label}` is `ERR_NEED_HOST_VALUE_INVALID`.
  - A need whose derived label exceeds 63 octets is refused with `ERR_NEED_HOST_VALUE_INVALID`, naming it.
  - Example 6's `tenants` is not answered from the template, and is `ERR_NEED_UNMET` naming `TELO_NEED_TENANTS__PATTERN`.
- **Collisions.**
  - Example 2 with both URLs `http://localhost:8080` refuses the load with `ERR_NEED_PUBLIC_URL_COLLISION`, naming `site`, `admin`, `http` and `localhost`.
  - Two patterns `http://*.t.localhost` on one port are refused the same way.
  - Example 3 with both URLs `https://shop.example` is refused, naming `http` and `admin`. With `http://localhost:8080` and `http://localhost:8081` it boots.
- **Parameters.** Each of these fails `telo check` with `NEED_PARAMETERS_INVALID`:
  - two needs with `primary: true`;
  - two `customDomains: true` needs on one port;
  - any parameter on a library's address need.
- **k8s.** On a routed session of example 2, both hosts reach the pod, and a watch edit adding a third need routes its host with the pod unchanged.
- **Report.** `telo needs report -o json` lists each address need with its type, `port`, `primary` and `customDomains`, and the env name of its field.
- **Studio.** The mounts list shows `hostnames` beside `path`, and its picker offers the address needs.
