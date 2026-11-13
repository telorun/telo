# telorun-release

The Rust half of `@telorun/release` (`release/nodejs`): the same release planner, and a `telo-release` binary that reads the same `telo-workspace.yaml`, refuses the same markers in the same words, plans the same versions, writes the same ledger, fragments and changelogs byte for byte, and answers the same JSON under `-o json`. It serves the `npm`, `cargo`, `docker` and `helm` ecosystems; a Telo module is served by `telo release`.

## The twin rule

- Each file twins the `release/nodejs/src` file of its name, kebab-case becoming snake_case: `lib.rs` twins `index.ts`, `node/mod.rs` twins `node/index.ts`, and `node/bin.rs` builds the binary; an `adapters/mod.rs` only declares its directory's modules. A file with no twin says why in its header: `yaml.rs` (Node reads and writes YAML with the `yaml` package) and `locale_order.rs` (`localeCompare`). The Telo glob is `telorun-glob` (`packages/glob/rust`), the twin of the `@telorun/glob` the Node half imports.
- The crate carries `@telorun/release`'s version and is MIT, as the package is.
- `release/conformance/` holds the answers both halves give, recorded from Node; `tests/conformance.rs` and `release/nodejs/tests/conformance.test.ts` run every row.

## Where it differs from Node

- **Malformed YAML.** Node's `yaml` recovers and reads what it can; this crate refuses the file, naming the fault in `saphyr-parser`'s words.
- **Sorting non-ASCII names.** `localeCompare` order is reproduced for ASCII only.

## Run

```sh
cargo run -p telorun-release --bin telo-release -- status
cargo test -p telorun-release
```
