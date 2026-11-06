# Declared keys

`ApiKey.DeclaredKeys` is a key source whose entries are written in the manifest: `{ id, digest, owner, scopes, expiresAt? }`. Only the digest is written, so a plaintext key never enters the application. A declared key is withdrawn by removing its entry and stops on its `expiresAt`; nothing is revoked, listed or recorded as used.

## Minting a key

`ApiKey.Generate` takes a `prefix` and returns the `key`, its `id` and its `digest`, with no store. Run it once:

```yaml
kind: Telo.Application
metadata: { name: MintKey }
imports:
  ApiKey: oci://ghcr.io/telorun/api-key@<version>
  Console: oci://ghcr.io/telorun/console@<version>
targets:
  - !ref mint
---
kind: Telo.Sequence
metadata: { name: mint }
steps:
  - name: minted
    invoke: { kind: ApiKey.Generate }
    inputs: { prefix: svc }
  - name: print
    invoke: { kind: Console.WriteLine }
    inputs:
      output: !interpolate "key=${{ steps.minted.result.key }}\nid=${{ steps.minted.result.id }}\ndigest=${{ steps.minted.result.digest }}"
```

Hand `key` to its holder; it is not stored anywhere and cannot be recovered. Write `id` in the entry. Put `digest` in the environment, not in the file:

```yaml
secrets:
  billingDigest: { env: BILLING_KEY_DIGEST, type: string }
---
kind: ApiKey.DeclaredKeys
metadata: { name: serviceKeys }
prefix: svc
scopes: [orders:read, orders:write]
keys:
  - id: apk_01tRy6czI6jAOLpZvq3hw1
    digest: !cel "secrets.billingDigest"
    owner: { type: service, id: billing }
    scopes: [orders:read]
    expiresAt: "2027-06-01T00:00:00Z"
```

A digest is not a secret that grants access, so a literal in a file that is committed is also safe; reading it from `secrets:` keeps entries out of the repository and rotates them with the deployment.

## Checks

| Rule | Refused when |
| --- | --- |
| `API_KEY_SCOPE_UNKNOWN` | An entry's scope is outside the source's `scopes`. |
| `API_KEY_ID_DUPLICATE` | Two entries declare one `id`. |

Both are reported by `telo check` at the entry (as `RESOURCE_RULE_VIOLATED` carrying the rule) and raised at start as `ERR_API_KEY_SCOPE_UNKNOWN` and `ERR_API_KEY_ID_DUPLICATE`. A digest that is not 43 base64url characters, or an `id` that is not an `apk_` id, is refused by the schema or at start.
