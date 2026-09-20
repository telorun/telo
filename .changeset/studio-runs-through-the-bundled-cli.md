---
"@telorun/studio": minor
---

Run applications through the bundled `telo` CLI by default on the desktop, instead of only through a Docker container.

Every desktop build now carries the `telo` executable it runs applications with, staged as a Tauri sidecar and built from the same commit as the editor — so a first launch runs a manifest with nothing installed, no image to pull, and no daemon. The shell supervises `telo runner` on loopback and the editor talks to it over the same `/v1` contract it uses for every other runner, so the new adapter is the same thin "where does the base URL come from" wrapper the Docker one is.

Which `telo` runs is never a property of the machine: the runner's one setting is the executable, defaulting to the bundled sidecar, and nothing searches `PATH` or compares versions. A build started with no sidecar beside it names this checkout's CLI explicitly instead. A manifest whose `requires: telo:` floor is above the bundled runtime reports that at the manifest, with the floor named.

The runner it starts allows only this editor's own webview origins, because a local API that runs code is reachable from every page the browser visits. Stopping a local runner from Settings now asks the adapter rather than a table of adapter names, so a third supervised runner needs no change there.

The Docker runner is unchanged and stays selectable — it is the one that runs an application the way production does, and it remains the only local option in the browser build. Only a first launch picks the CLI runner; an existing selection is left alone.
