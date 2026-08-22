---
"@telorun/cli": minor
---

Shrink the `telorun/node` Rust images from ~2.6 GB to ~1.08 GB.

The Rust toolchain is installed with `rustup set profile minimal`, which drops
rust-docs (796 MB of HTML the image can never serve) along with clippy and
rustfmt, which nothing invokes; the toolchain's `share/` tree and rustup's own
download caches go with them. rustc, cargo, rust-std and rustdoc remain, which is
everything a `pkg:cargo` controller build needs — verified by linking both a
binary and a cdylib in the built image.

The C build environment is stated rather than inherited: gcc, libc6-dev, make and
pkg-config. The non-slim base used to supply make, pkg-config, git and python3
incidentally; make and pkg-config are now installed explicitly (~1 MB), and git,
python3 and cmake are documented as absent.

There is no longer a non-slim Rust image. The toolchain needs nothing from the
fat base, which cost ~990 MB, so `telorun/node:<ver>-rust-<rust-ver>` and
`…-rust-<rust-ver>-slim` are now the same slim-based image under two names.
