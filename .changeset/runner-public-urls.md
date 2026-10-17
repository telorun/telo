---
"@telorun/runner-core": minor
"@telorun/k8s-runner": minor
"@telorun/debug-wire": patch
---

Runners route an application's public addresses. `PortMapping` gains `publicHosts`, read from the `publicUrls` each `Kernel.PortsResolved` port entry now carries. A routed k8s session sets `TELO_HOST_PUBLIC_URL_TEMPLATE=https://{port}-<session>.<base domain>` on every application container, and on a watch session also `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE=https://{label}--{port}-<session>.<base domain>`; it routes every announced host ending in `-<session>.<base domain>` beside the port's own — in the port's HTTPRoute `hostnames` or as an Ingress rule — and republishes a watch session's routes when a port's hosts change. A one-shot run answers each port's primary address only. The runner-core README states the host contract (report mode and template mode) any host serving an application's addresses meets, and the debug-wire README documents `publicUrls`.
