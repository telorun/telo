---
"@telorun/cli": minor
---

`telo changed <paths..>` — answers whether anything a module entry point depends on moved since a git ref, so an expensive CI job can be gated on its own dependency graph instead of paying on every push. An argument is a module entry point (a directory holding `telo.yaml`, or a `telo.yaml` itself), walked transitively through its **relative** `imports:` edges — the same edges `telo release` propagates a version bump along, and no payload is built to follow them. Anything else, including a manifest under another name, is a glob matched literally against the diff. Patterns and the diff are both spelled relative to the repository root, so the answer does not depend on where the command runs from. Exits 0 for "changed", 1 for "unchanged"; when the diff cannot be taken at all it reports "changed" (`--no-fail-open` inverts that), and `-o json` carries the verdict, the resolved patterns and the matched files.
