---
"telo-vscode": minor
---

Remove the `telo.registryUrl` setting from the VS Code extension.

The setting overrode the base URL of the module registry that resolves imports during analysis. Import resolution now uses the kernel transport registry's own default, so `registry://` and bare refs resolve exactly as they do under `telo check` with no configuration. Nothing else read the setting — `telo.hubUrl`, which drives federated import autocomplete and the upgrade lenses, is a separate concern and is unchanged.
