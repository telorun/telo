---
"@telorun/cli": minor
"@telorun/debug-wire": patch
---

`telo run --inspect` (and `--debug`) now reports every `Telo.OpenUrl` call on the debug stream as a `Kernel.OpenUrlRequested` event carrying the URL, so a runner can open the page for the user. The event is sent for every call regardless of the manifest's `logging:` settings and even with `--no-input`, where nothing is opened locally; at a terminal the browser opener still runs once per URL as before.
