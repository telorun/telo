---
"@telorun/cli": patch
---

Inspect debug UI: surface an explicit failure (including the exact fetch URL and HTTP status / error) when the on-demand UI bundle can't be resolved or fetched, instead of a generic "not available" notice — the reason is shown in the endpoint's 503 and logged at startup. Add a `TELO_DEBUG_UI_VERSION` override so the version to fetch can be set when the CLI manifest doesn't carry a concrete one (e.g. container images built via `pnpm deploy`, where `workspace:*` isn't rewritten).
