---
"@telorun/cli": patch
---

`telo --version` prints the telo identity: `X` for a release, and `X+unreleased` for a build made from a working copy while `X` is pending — the string a run's `Kernel.Starting` event and `telo builtins`' root `metadata.version` carry. It used to print the CLI package's number, which on a working copy named a release the build is not (`0.118.0` where the archive said `0.119.0+unreleased`). A release prints the same `X` as before. The Rust `telo` gains `--version` too, printing the same string, read from the built-in vocabulary it embeds.
