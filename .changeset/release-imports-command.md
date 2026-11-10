---
"@telorun/cli": minor
---

`telo release imports <paths..> --as=published|relative` writes each import of a release-workspace module in the named manifests either as the published, registry-pinned reference of the module's version in the tree or as the relative path to the module's directory; `--check` exits 1 listing every import not in that form, and an import of the module a manifest sits inside is always relative. `telo upgrade --pin-local` is deprecated and now runs `--as=published` on the manifests it names.
