---
"@telorun/cli": minor
---

`telo run` now collects `.env` / `.env.local` from every directory between the manifest and the workspace root, instead of the manifest's own directory alone. `telo-workspace.yaml` is the bound — only its location, never its `modules:` list — so a monorepo keeps shared development values in one file at the root. With no marker above the manifest the behaviour is unchanged. The nearest declaration wins, `.env.local` beats `.env`, and the real environment still beats every file; `--debug` prints which files were loaded, and a file that exists but cannot be read is always reported rather than treated as absent.
