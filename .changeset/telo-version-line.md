---
"@telorun/sdk": minor
"@telorun/templating": minor
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
"@telorun/ide-support": minor
"@telorun/language-server": minor
---

Changed: the telo runtime packages share one version line. `@telorun/sdk`, `@telorun/templating`, `@telorun/analyzer`, `@telorun/kernel`, `@telorun/cli`, `@telorun/ide-support` and `@telorun/language-server` form one changesets `fixed` group (the `linked` group is gone): a changeset naming any of them releases all of them at one version, so this release puts every member on the same number, and that number is the manifest surface generation a module's `requires: telo:` range is written against. `TELO_SURFACE_VERSION` is the line's version with any pending bump applied, and the Rust twins (`telo-kernel`, `telo-cli`, `telo-analyzer`, `telo-templating`, `telorun-sdk`) carry their Node twin's version in `Cargo.toml` and `Cargo.lock`.
