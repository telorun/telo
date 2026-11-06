# Authz

Authorization policies implementing `Auth.Policy`.

| Kind | What it is |
| --- | --- |
| `Authz.CelPolicy` | Ordered rules over the caller, action, resource and context; the first match decides, no match denies. See [CEL policy](./docs/cel-policy.md). |

```yaml
imports:
  Authz: oci://ghcr.io/telorun/authz@<version>
---
kind: Authz.CelPolicy
metadata: { name: orders }
rules:
  - when: !cel "principal == null"
    allow: false
    reason: sign in first
  - when: !cel "principal != null && action == 'GET /orders' && 'orders:read' in principal.scopes"
  - when: !cel "principal != null && action == 'POST /orders'"
    allow: false
    reason: write scope needed
    requiredScopes: [orders:write]
```
