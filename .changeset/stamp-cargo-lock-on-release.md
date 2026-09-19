---
"@telorun/analyzer": patch
"@telorun/cli": patch
---

`telo release apply` now moves a module's crate version in the `Cargo.lock` that records it, beside `telo.yaml`, `nodejs/package.json` and `rust/Cargo.toml`. A lockfile left behind still named the crate's previous version, so every `cargo --locked` invocation had to re-resolve — which means reaching the network, which `--locked` forbids. Only a path package is addressed; a registry package of the same name is left alone, and a name recorded more than once without a source is refused rather than guessed at.
