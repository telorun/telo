---
"@telorun/cli": minor
---

`telo run --watch` no longer holds the application open between edits (breaking). Each reload runs as a plain `telo run` would: an application that finishes — a script with no server — runs to completion, its resources are torn down, `Kernel.Stopped` carries its exit code on the `--debug` / `--inspect` stream and the session prints `[watch] finished with exit code <n>; waiting for changes`, then waits for the next change, kept alive by its file watchers and the `--inspect` endpoint. The next edit starts a new generation. A server is unchanged: it keeps serving until a change restarts it or the session is stopped.
