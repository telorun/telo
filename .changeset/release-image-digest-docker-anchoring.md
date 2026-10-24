---
"@telorun/cli": patch
---

`telo release` reads an image module's `Dockerfile.dockerignore` (or `.dockerignore`) as Docker does: every pattern is anchored at the module root, and a pattern naming a directory leaves out everything beneath it. The digest deciding whether such a module bumps now covers exactly the files the image build receives, so a file outside the image — a Helm chart a release stamps after recording `.changes/ledger.yaml`, a `tests/` directory — no longer moves it. This ends the version-modules pull request that republished `apps/hub` after every release with nothing changed. An ignore line using a character class (`[a-z]`) or an escape is refused, naming the file and line, rather than read differently from Docker.
