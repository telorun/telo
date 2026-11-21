# Design notes

Why the module's manifest is written the way it is.

## Declarations

- **One home for `returns:` and `catches:`.** Every slot — `Server.notFoundHandler`, the two scope-level catch lists and each route of `Http.Api` — anchors at the `http-dispatch` library's `Outcomes` shapes, so the entry shape, the MIME negotiation rules and the buffered/streamed alternatives live in exactly one place. `Api.routes[]` once carried an inline copy of both.
- **`mounts` is a dispatch list.** `entries` on the array, `matcher` on the field that selects one and `handler` on the reference it dispatches to are the same three tokens `Http.Api.routes` carries. They let the editor render mounts as an ordered list rather than a set of nodes; mount order is match order, which a picture of nodes cannot carry.
- **A mount reference is a `dependency` that throws through.** The server holds the mount and calls a convention method on it, and control reaches a route through the mount's own `trigger.inbound` slot. A throw from that route nevertheless arrives at the server's error handler because nothing below claimed it, so the throws closure and the catch scope cross the slot.
- **The catch lists on the server and the router use the empty pointer.** Each covers everything that server or router drives rather than one sibling field's target. The four access refusals are raised by the server itself and answered by default. Neither list has a route to type `request.query`, `body` or `params` from; those belong to a route's own list. A route entry with no `when:` is a deliberate full override, which makes the router's entries unreachable for that route alone.
- **No `logger:` field.** Request logging is not a per-server flag; the structured logging pipeline governs it. Fastify's per-request access lines are `info` severity, so they appear while the server's scope is at `info` or below (the default) and are suppressed by importing the module with `logging: { level: warn }`. See [Log events](./log-events.md).
- **A route handler takes either executable capability.** A `Telo.Runnable` whose controller also implements `invoke()` — a sequence, for one — produces the response body from either, and the kernel calls whichever fits.
- **`Http.Reference` carries a referrer rule.** The OpenAPI document is the server's, collected from every mounted route's schema, so a reference mounted on a server declaring no `openapi:` block has nothing to render and would fail at boot after the port is claimed. The rule sits on the reference because the requirement is that kind's; a server should not have to know which mounts need what.
- **Credential sources publish more than a credential.** A source's reading publishes `schemes` (the authentication schemes a request lacking its credential is challenged with) and may publish `originCheck: { trustedOrigins }` (for a credential the browser sends on its own), `requiresTrustedProxy: true` and `bearerMethod` (`header` or `query`, the RFC 6750 method a Bearer token is read by). Normative: [Authentication](./authentication.md).

## Scalar bundle

Scalar's browser bundle is `@scalar/api-reference`'s browser build (`dist/browser/standalone.js`, the script `@scalar/fastify-api-reference` embeds), staged from the upstream archive and fetched lazily, so an app that declares no `Http.Reference` never downloads it; its notice comes from `@scalar/fastify-api-reference`. `sources.scalar.version` must be the `@scalar/fastify-api-reference` release whose `@scalar/client-side-rendering` and `@scalar/json-magic` versions `nodejs/package.json` pins, so the page HTML and the script reading it come from one release; `nodejs/tests/scalar-release.test.ts` checks it.

## Floor history

The module's `requires.telo` is measured. What raised it, release by release:

- Controllers return their effects from `init()` and `run()`; a runtime that does not execute a returned chain allocates nothing and undoes nothing.
- 0.91.0: a `sources:` entry claimed by an `assets:` pattern (an older analyzer rejects it as unclaimed) and `ctx.resolveControllerFile`, which the reference controller calls.
- 0.98.0: `Http.Static.root` is a `Telo.HostPath`; 0.121.0: it declares `entry: directory`.
- 0.104.0: the request span continues an inbound `traceparent`, which an older kernel ignores and so roots every trace, and the controllers import `errorTypeOf` from the SDK, which earlier runtimes do not export.
- 0.108.0: the request binding copies a framework's own bag into a plain object with `isCelRecord`; where the SDK lacks that export, a route dies at creation.
- 0.123.0: `Http.Server` declares `throws.codes` with a `displayMessage`, and the controllers call `ctx.declaredDisplayMessage`.
- 0.129.0: the controllers read `ctx.translations` to negotiate `request.lang`.
- 0.130.0: the controllers import `errorValueOf` for the `streamFailed` failure trace, and the mount authentication schema uses `x-telo-context-from-referrer`, `x-telo-context-nullable-when`, `x-telo-ref.outputTo` and the object form of `x-telo-catches-for`.
- It is deliberately not raised for the scope-level `catches:` lists: 0.87.0 reads the module with no issues, because both new annotation forms degrade to silence there. A floor nothing can refute is a claim nothing checks.
