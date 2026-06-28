---
"@telorun/kernel": minor
"@telorun/analyzer": minor
---

Remove the `env` CEL global. Manifests can no longer read raw host environment
variables via `${{ env.X }}` — that path was long superseded by per-field `env:`
bindings on typed `variables:` / `secrets:` / `ports:` entries.

To reach a host variable, declare a typed root entry bound to it and reference
the resolved value:

```yaml
secrets:
  apiKey: { env: OPENAI_API_KEY, type: string, default: "" }
# then: !cel "secrets.apiKey"
```

The kernel no longer forwards `process.env` into the root module's CEL scope
(`this.env` still feeds `variables`/`secrets`/`ports` resolution and the
controller `ResourceContext`), and the analyzer drops `env` from the kernel
globals, so `env.X` now fails static analysis as an undeclared reference. No
deprecation shim — references must migrate to a declared `variables:`/`secrets:`
entry.
