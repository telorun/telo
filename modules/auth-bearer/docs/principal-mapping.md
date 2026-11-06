# Principal mapping

The principal's `subject` is `sub`, `issuer` the verified issuer, `amr` and `acr` come from the claims of those names, `authenticatedAt` from `auth_time`, `via` is the verifier's resource name, and `sessionId` is null. `claims` is the token's claims, or the introspection response. The remaining members are read from standard claims unless `principal:` overrides them with an expression over `claims`:

| Member | Default | Override |
| --- | --- | --- |
| `kind` | `service` when `sub` equals `client_id`, else `user` | `principal.kind`, `user` or `service` |
| `scopes` | `scope` (space-delimited string), else `scp` (string or list) | `principal.scopes`, a list of strings |
| `roles` | `roles` | `principal.roles` |
| `permissions` | `permissions` | `principal.permissions` |
| `org` | null | `principal.org`, a string or null |

```yaml
principal:
  roles: !cel "claims.realm_access.roles"
  org: !cel "claims.tenant"
```

A default claim in the wrong shape (a number where a list is expected) refuses the token as `claims`. An override that evaluates to the wrong type is a configuration error, thrown as `ERR_AUTH_BEARER_PRINCIPAL_INVALID`.
