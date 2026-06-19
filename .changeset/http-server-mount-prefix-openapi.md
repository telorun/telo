---
"@telorun/http-server": patch
---

Fix OpenAPI documentation conflating routes from different mounts.

Each `Http.Api` route is now registered at its full `<mountPrefix><path>` instead of inside a Fastify `{ prefix }`-encapsulated context, and the generated OpenAPI `servers` block is a single origin (`baseUrl`, the forwarded host, or relative `/`) rather than one entry per mount prefix. Previously `@fastify/swagger` stripped each mount's prefix from the documented path while the prefixes were hoisted into `servers`, so different APIs mounted at different prefixes collapsed together — e.g. an `Http.Api` mounted at `/admin` was documented at `/links` instead of `/admin/links`. Actual request routing was unaffected; this corrects only the generated document.
