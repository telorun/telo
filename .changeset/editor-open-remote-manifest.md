---
"@telorun/editor": minor
---

Add "Open in Telo Editor" support: launching the editor with a `?open=<url>` query parameter fetches a manifest over HTTP (e.g. a GitHub raw URL) and copies it into an in-browser virtual workspace under `/workspace/apps/<slug>/telo.yaml` for local editing. Relative (same-origin) imports cascade — their files are fetched and persisted verbatim, mirroring their layout relative to the root (without escaping the workspace) — while registry imports continue to resolve via the configured registry adapters. Before anything is written, a confirmation dialog previews the application/library name, description, declared imports, and the exact list of files to be created (flagging overwrites). A toast confirms the import. `loadWorkspace` now also resolves local imports that point at non-`telo.yaml` files copied in by a cascade.
