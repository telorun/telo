---
"@telorun/k8s-runner": minor
---

Add per-session ingress origin TLS — the session Ingress can present a predefined
`kubernetes.io/tls` Secret (e.g. a Cloudflare Origin cert) for Full (Strict)
upstreams, via `sessionIngress.tls.{secretName,cert,key}`.

Rename the session-ingress surface to disambiguate from the runner's own endpoint:
env `RUNNER_INGRESS_*` → `SESSION_INGRESS_*`, Helm `ingress:` → `sessionIngress:`.
