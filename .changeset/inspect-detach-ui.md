---
"@telorun/debug-ui": minor
"@telorun/cli": minor
---

Ship the debug UI on demand instead of bundling it in the CLI, and give the
inspection endpoint its own composable flag set.

- `telo run --inspect[=[host:]port]` starts the live inspection endpoint
  (default `127.0.0.1:9230`; non-loopback binds print a security warning) and
  serves the UI same-origin, with a `/json/version` discovery handshake.
  `--no-open` suppresses auto-opening the browser. `--debug` is a separate,
  composable flag that writes only the `.telo.debug.jsonl` event log (no network,
  no UI).
- The CLI does not bundle `@telorun/debug-ui` (it's a `devDependency`). The UI is
  fetched on demand from npm via jsDelivr and cached under the `.telo` cache
  root; in the monorepo it resolves from the workspace, so local builds are
  testable offline. `TELO_DEBUG_UI_PATH` overrides the bundle path; `TELO_DEBUG_UI_URL`
  overrides the CDN base.
- `@telorun/debug-ui` builds a self-contained single-file bundle
  (`app-single/index.html`) alongside `app-dist/`.
