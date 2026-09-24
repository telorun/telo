---
"@telorun/cli": minor
---

Changed: `telo changed` now takes glob patterns and lists which matched files a change since `--base` reaches, instead of answering one yes/no for all its arguments — so CI can select the test manifests a pull request affects (`telo changed 'modules/*/tests/*.yaml' -o json` → `{ base, diffed, affected, unaffected }`). A `telo.yaml` is reached through its directory and its relative imports, any other Telo manifest through itself, its `__fixtures__/` and its relative imports, and any other file through itself; the closure now also follows the `workspace:` dependencies a module's controller source bundles. The exit code is 0 for any answer and non-zero only on failure, a diff that cannot be taken reports every matched file as affected, and `--fail-open` is removed. A directory argument is no longer accepted: name its `telo.yaml`.
