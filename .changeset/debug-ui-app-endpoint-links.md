---
"@telorun/debug-ui": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

Debug UI now links to the running application's exposed ports.

- `@telorun/debug-ui`: `DebugPanel` takes an `endpoints` prop and renders each as
  a link in its header (tcp → clickable `http://host:port`, udp → plain label).
  New `AppEndpoint` type + `endpointHref` / `endpointLabel` helpers (browser-safe,
  no runner/kernel dependency). The standalone `DebugWatcher` sources endpoints
  from the producer's `/json/version` handshake, filling a blank host from the
  page origin so the link points where the viewer reached the server (localhost
  locally, the bound host remotely).
- `@telorun/kernel`: new `Kernel.getResolvedPorts()` — the root Application's
  resolved `ports:` (integer + declared protocol per name), available after
  `load()`. Empty when the root declares no ports.
- `@telorun/cli`: the `--inspect` server advertises the app's resolved ports as
  `appEndpoints` in its `/json/version` handshake. The UI now opens once the
  ports are known (deferred from server start to first load), so the discovery
  handshake already carries the endpoints.

The editor (private) renders the same links inside `DebugPanel` from its resolved
run endpoints, replacing the separate chips in the run-view header.
