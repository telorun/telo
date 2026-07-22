---
"@telorun/kernel": minor
"@telorun/cli": minor
---

Remove the Telo module registry as a publish/discovery surface; the hub is now the discovery path.

The `registry.telo.run` origin stays a read-only resolution source, so apps that
import bare `namespace/name@version` refs keep resolving and running unchanged.
`telo run` / `install` / `check` / `module` / `upgrade` are unaffected — they
resolve and enumerate versions against the still-deployed origin. What is removed:

- **`telo publish` targets OCI only.** A non-OCI (HTTP registry / bare-host)
  destination is rejected with a clear error; publish to `oci://host/repo`.
  `--registry` remains, used solely to resolve/pin dependencies read-only.
- **`RegistryTransport.publish()` now throws** — the transport is read/resolve
  only. Resolution, cache placement, version listing, digest, and manifest
  hashing are unchanged.
