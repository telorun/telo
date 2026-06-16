---
"@telorun/k8s-runner": minor
---

k8s-runner: per-session Ingress now exposes every tcp port under its own host `<port>-<sessionId>.<domain>` (one Ingress rule per port), matching the docker runner's proxy scheme — previously only the first port was routed. The port rides as a leading label, so each host stays a single label under the base domain and remains compatible with a single-label wildcard cert. Announced endpoints carry a `url` for each tcp port; udp ports stay host-less.
