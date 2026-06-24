---
"@telorun/cli": minor
---

Give the `telorun/node` image a smart entrypoint, modeled on the official node image's `docker-entrypoint.sh`. It prepends `telo` only when the first argument is a flag (`-…`), an unknown command, or a non-executable file — so `docker run telorun/node ./telo.yaml` and `docker run telorun/node --watch ./telo.yaml` both reach the CLI, while `bash`, `sh`, and `node` still run verbatim as escape hatches. A derived image may write either the explicit `CMD ["telo", ".", "--watch"]` or the terse `CMD ["./telo.yaml"]` — both work; the bare image runs the CLI via the default `CMD ["telo"]`.
