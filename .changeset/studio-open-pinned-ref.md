---
"@telorun/studio": minor
---

The web build's `?open=` parameter also takes a pinned published ref, `oci://<host>/<repo>@<version>#sha256-<pin>` (with `#` encoded as `%23`). Studio reads the manifest through the hub's manifest cache, verifies it against the pin, and copies it alone into `/workspace/apps/<slug>/telo.yaml`; the confirmation lists the payload layers its `layers:` index declares that are not copied. A ref with no version or pin, a pin that arrived as the page fragment, a version the cache does not hold and a pin mismatch are each refused with an actionable message. `https://` links behave as before.
