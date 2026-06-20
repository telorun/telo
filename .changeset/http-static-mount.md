---
"@telorun/http-server": minor
---

Add `Http.Static`, a `Telo.Mount` that serves a directory of static assets (a built SPA, plain HTML, images, …). Mount it on an `Http.Server` alongside an `Http.Api` so one application delivers both its API and its frontend. Supports a manifest-relative `root` (assets ship with the app), `index`, `spaFallback` for client-side routing, and `maxAge` / `immutable` cache control. Backed by `@fastify/static` (MIME, ETag, conditional and range requests).
