---
"@telorun/http-server": patch
---

Fix `Http.Server` failing to boot under Fastify 5, and derive request logging
from the logging pipeline rather than a per-server flag.

The Telo-backed logger adapter was passed to Fastify's `logger:` option, which
in Fastify 5 only accepts a boolean or config object — a custom instance must go
through `loggerInstance:`. Booting a server with request logging on threw
`FST_ERR_LOG_INVALID_LOGGER_CONFIG` at construction. The adapter is now wired
through `loggerInstance`.

The `logger:` manifest field is **removed**. Whether the server instruments
requests is derived from its resolved logging scope threshold: Fastify's
per-request access lines are `info`-severity, so they appear whenever the
server's scope is at `info` or below (the default) and are suppressed by raising
the http-server import to `level: warn` — which also skips the per-request work
entirely instead of building a record and discarding it. A boolean toggle only
duplicated what the threshold already expresses (`warn` keeps server error logs
while dropping access noise, since they differ in severity). The Server schema is
open, so an existing `logger:` value validates and is ignored.
