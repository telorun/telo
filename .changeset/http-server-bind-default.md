---
"@telorun/http-server": patch
---

The `host` schema default now matches the controller runtime default (`0.0.0.0`) instead of `localhost`. This keeps forwarded ports reachable when the server is run inside a container; the controller already defaulted to `0.0.0.0` at runtime, so the manifest schema now reflects actual behavior.
