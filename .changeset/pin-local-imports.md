---
"@telorun/cli": minor
---

`telo upgrade --pin-local` rewrites a relative import of a released workspace module to its published pin once the published artifact matches the working copy, and keeps it relative — printing the release plan's reason — while a change to that module is unreleased. `telo upgrade -o json` now also lists each upgrade, repin and kept-local import with the manifest that holds it.
