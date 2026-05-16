---
"@telorun/http-dispatch": minor
---

Publish `HttpDispatch.Request` carrier alongside `HttpDispatch.Outcomes`.

`packages/http-dispatch/telo.yaml` now exports a second `Telo.Definition` (`capability: Telo.Type`, name: `Request`) whose `schema.$defs.Matcher` carries the canonical HTTP request matcher value-shape — `method` / `path` / `query` / `body` / `headers` with `path` + `method` required and the `method` enum locked to the seven standard methods. Same `Telo.Type` pattern as `Outcomes`: pure schema carrier, never instantiated, consumed by HTTP-shaped transports (http-server, lambda, …) via `x-telo-schema-from: "HttpDispatch.Request/$defs/Matcher"` on their per-route `request:` field.

Consumers keep their own per-field annotations on the consuming side (`x-telo-topology-role: matcher`, `x-telo-context-from: "request/schema"` navigation from sibling `inputs:` / `returns:` / `catches:` context blocks). The carrier owns the structural value-shape only.

No consumer migrates in this changeset — `http-server.Api.routes[].request` and `Lambda.HttpApi.routes[].request` adopt the anchor in their own follow-ups. This change is the prerequisite that unblocks both.

Polyglot contract: matcher schema travels through the carrier across languages, not through any TS package.
