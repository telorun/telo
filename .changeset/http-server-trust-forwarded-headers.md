---
"@telorun/http-server": minor
---

`Http.Server`: the generated OpenAPI `servers` URL now defaults to a **relative** path (the mount prefix), so the reference UI and spec are correct behind any proxy/ingress/origin with no configuration — fixing the previous hardcoded `http://<bind-host>:<port>` that didn't match the reachable URL. Add an opt-in `trustForwardedHeaders` boolean: when enabled the server honors the standard `X-Forwarded-Proto` / `X-Forwarded-Host` headers and advertises an absolute `servers` URL (and request protocol/host) matching the fronting proxy. An explicit `baseUrl` still overrides both.
