# telorun-release

The Rust half of `@telorun/release` (`release/nodejs`): the same release planner, and a `telo-release` binary that reads the same `telo-workspace.yaml`, refuses the same markers in the same words, plans the same versions, writes the same ledger, fragments and changelogs byte for byte, and answers the same JSON under `-o json` and the same document under `-o markdown`, renders the same tags from `tagFormat`, reads the same version files (a plain-text file, a TOML pointer, `pyproject.toml`) and runs the same `baseline`. It serves the `npm`, `cargo`, `docker`, `helm` and `pypi` ecosystems — `pypi` running the Node half's own PEP 517 frontend (`pypi-build-sdist.py`, embedded at build) — and a Telo module is served by `telo release`.

## The twin rule

- Each file twins the `release/nodejs/src` file of its name, kebab-case becoming snake_case: `lib.rs` twins `index.ts`, `node/mod.rs` twins `node/index.ts`, and `node/bin.rs` builds the binary; an `adapters/mod.rs` only declares its directory's modules. A file with no twin says why in its header: `yaml.rs` (Node reads and writes YAML with the `yaml` package) and `locale_order.rs` (`localeCompare`). The Telo glob is `telorun-glob` (`packages/glob/rust`), the twin of the `@telorun/glob` the Node half imports.
- The crate carries `@telorun/release`'s version and is MIT, as the package is.
- `release/conformance/` holds the answers both halves give, recorded from Node; `tests/conformance.rs` and `release/nodejs/tests/conformance.test.ts` run every row.

## Where it differs from Node

- **Malformed YAML.** Node's `yaml` recovers and reads what it can; this crate refuses the file, naming the fault in `saphyr-parser`'s words.
- **Sorting non-ASCII names.** `localeCompare` order is reproduced for ASCII only.
- **Unknown options.** Node refuses an option no command declares (exit 2); this binary ignores it, except `--max-length`, which every release command declares (hidden off the plan commands) and refuses in Node's words.
- **A simple index's file links.** Resolved against the project page by RFC 3986, with the WHATWG URL standard's percent-encoding of the path and query; Node's `URL` also normalizes the host (IDNA, letter case) and a default port.

## Run

```sh
cargo run -p telorun-release --bin telo-release -- status
cargo test -p telorun-release
```
