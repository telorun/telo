---
"@telorun/editor": minor
---

Add "Open in Telo Editor" support: launching the editor with a `?open=<url>` query parameter fetches a single manifest over HTTP (e.g. a GitHub raw URL), copies it into an in-browser virtual workspace under `/workspace/apps/<slug>/telo.yaml`, and opens it for local editing. If a module with the same slug already exists, the user is prompted to confirm an overwrite via an alert dialog. A toast confirms a successful load.
