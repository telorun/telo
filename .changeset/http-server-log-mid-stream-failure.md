---
"@telorun/http-server": patch
---

Log mid-stream failures server-side. When a `mode: stream` route's stream throws
after the response headers are flushed, the failure can't reach Fastify's error
handler or a `catches:` entry, so it was previously silent for the operator (it
was only emitted as an `Http.Api.streamFailed` event, which nothing logs unless a
debug consumer is attached). The stream-error hook now also logs on the server's
request logger (the one `Http.Server.logger` configures) at `error` level with
the error, route, status, and MIME. Client-facing behaviour is unchanged.
