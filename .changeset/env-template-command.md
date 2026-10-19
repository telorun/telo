---
"@telorun/cli": minor
---

`telo env template <manifest>` writes every environment variable an application reads — its `env:`-bound `variables:` / `secrets:` / `ports:` entries and every need field `telo needs report` lists — as commented-out `.env` / `.env.local` lines, one per variable, grouped by where it comes from, with a trailing comment for `required`, the entry's description and a need field's path. Secrets and need fields marked sensitive go to the workspace's sensitive env file (`.env.local` by default), everything else to `.env`. Nothing is uncommented: an empty `NAME=` would set the variable to the empty string, and a written default would override a later change to the manifest. A secret's default is never written. It prints both files by default; `--write` adds to the files beside the manifest only the variables they do not already mention, and warns when a sensitive file it wrote is not ignored by git.
