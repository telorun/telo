---
"@telorun/mcp-server": minor
---

Add `stateful` flag to `Mcp.HttpEndpoint` and flip the default to stateless. In stateless mode (the new default) every request builds a fresh SDK `Server`+transport pair, no `Mcp-Session-Id` is minted, and the endpoint scales horizontally without sticky session affinity at the load balancer. Set `stateful: true` to keep the v1 behaviour where each session owns an in-memory `Server` keyed by `Mcp-Session-Id` — required for server-pushed notifications, resource subscriptions, and tool inputs that branch on `request.session.id`. The transition is transparent for tools-only consumers; clients that previously relied on session continuity should opt in to `stateful: true` and configure header-based affinity at their LB if they run more than one replica.
