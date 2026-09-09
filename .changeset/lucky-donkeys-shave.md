---
"@telorun/runner-core": minor
"@telorun/k8s-runner": minor
---

Support Gateway API alongside Ingress, and verify that a published route was actually programmed.

The k8s runner only ever created `networking.k8s.io/v1` Ingress objects. On a cluster that routes with Gateway API those are reconciled by nobody: the session pod is healthy, every declared port is reachable from the runner, and every public URL 404s — with no error, no event and nothing in the session's status to say so.

`sessionRouting.mode` (`auto` | `ingress` | `gateway` | `none`, `SESSION_ROUTING_MODE`) now selects the layer, and `auto` resolves on what is **configured** before what is **installed**: a named Gateway wins, then an IngressClass, and only then the cluster's own APIs. That order is deliberate — Gateway API CRDs are frequently present without being the intended path, so their presence is not evidence of intent. Where two usable layers exist and nothing was configured, the runner refuses to start rather than guessing, because a wrong guess is silent.

Gateway mode publishes **one HTTPRoute per port**. Gateway API scopes `hostnames` to the whole route while a rule matches on path and never on host, so a single route carrying every session hostname would send them all to whichever rule matched `/` first.

Route health is a new axis on the `/v1` stream (`type: "route"`, `pending` / `programmed` / `unprogrammed`), separate from reachability on purpose: reachability dials the workload's own address and proves only that the app is listening. Gateway API answers precisely, from the `Accepted` / `ResolvedRefs` conditions its controller writes — so a route refused because a listener does not admit the session namespace now says `NotAllowedByListeners` instead of timing out with no cause. Ingress has no rejection signal, so there an unclaimed route is caught by the timeout.

Route health is reported, never fatal, and a route the runner could not READ is distinguished from one no controller claimed — a permission error reported as "no controller claimed the Gateway route" sends an operator to inspect the wrong thing.

**Breaking (chart + env):** `sessionIngress.*` becomes `sessionRouting.*`, with `className` and `tls` moving under `sessionRouting.ingress` and `controllerNamespace` becoming `sessionRouting.dataPlaneNamespace` — it must name the routing data plane, which is not an ingress controller under Gateway API. `SESSION_INGRESS_BASE_DOMAIN` becomes `SESSION_ROUTING_BASE_DOMAIN`. The chart **refuses** a values file still carrying `sessionIngress.*`: Helm ignores unknown keys, so an un-migrated upgrade would otherwise boot a runner that logs `session routing disabled (logs-only)` and drops every session URL.

`SESSION_INGRESS_TLS_SECRET` is refused whenever routing **resolves** to Gateway API — not only under an explicit `mode: gateway` — because under `auto` (the default) a named Gateway decides the layer, and the certificate would be silently ignored.

A **default-marked** IngressClass (`ingressclass.kubernetes.io/is-default-class`) counts as configured intent under `auto`, ranked with a named Gateway and a configured class. Without it, a cluster shipping the Gateway API CRDs beside a default ingress controller — a common shape — would refuse to boot after this upgrade despite having worked before.
