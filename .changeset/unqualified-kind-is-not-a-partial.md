---
"@telorun/language-server": patch
---

A YAML file beside a module whose `kind:` is unqualified — a Kubernetes manifest or a Helm template (`kind: Deployment`) — is no longer taken for a partial of that module, and no longer warned as "not listed in the 'include' field". A partial declares a module-qualified kind (`Run.Sequence`), which is what the engine now looks for; a stray file declaring one is still warned.
