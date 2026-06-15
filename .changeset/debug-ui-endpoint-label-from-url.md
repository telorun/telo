---
"@telorun/debug-ui": patch
---

Endpoint links now label from the endpoint's absolute `url` (its authority) when present, so the displayed text matches the link actually opened. Previously a proxy/ingress endpoint showed a `host:port` label whose host wasn't the routable one (and, for ingress, a port that isn't the externally served one).
