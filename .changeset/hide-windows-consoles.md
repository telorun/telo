---
"@telorun/cli": patch
"@telorun/studio": patch
---

No console windows on Windows

Telo Studio no longer opens a console window on Windows when it checks for Docker in settings or starts, stops or talks to a local runner (the `docker`, `telo runner` and `taskkill` processes now start without a window). `telo runner` also starts each session's `telo run` and its `taskkill` with their windows hidden.
