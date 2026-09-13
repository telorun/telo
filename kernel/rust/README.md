# Telo kernel (Rust)

A second Telo kernel, written in Rust. It loads a manifest, resolves resources, loads Rust controllers out of `cdylib`s, and dispatches invocations — no JavaScript anywhere in the path.

This is step one. It exists to prove the kernel itself can be a different language, not to reach parity with `kernel/nodejs`. See [`plans/rust-kernel-hello-world.md`](../../plans/rust-kernel-hello-world.md).

## Running

```
cargo run -p telo-cli -- run kernel/rust/tests/fixtures/hello-world/telo.yaml
```

Building needs a C compiler on the host: the registry client's TLS (`rustls`, through `ureq`) depends on `ring`, which compiles C and assembly.

The first run builds `modules/console/rust`; later runs hit Cargo's incremental cache. Success is `Hello from Telo!` on stdout and exit code 0.

`cargo test -p telo-kernel -p telo-cli` runs the fixtures end to end.

## What it supports

| Area           | Supported                                                                             |
| -------------- | ------------------------------------------------------------------------------------- |
| Documents      | `Telo.Application`, `Telo.Library`, `Telo.Definition`, resource docs                   |
| Module scope   | `imports` (local relative paths and `oci://` refs), `exports.kinds`, `exports.resources`, `Self.<Kind>` |
| References     | `!ref <name>`, `!ref Self.<name>`, `!ref <Alias>.<name>`                               |
| Capabilities   | `Telo.Invocable`                                                                       |
| Targets        | inline invoke steps with literal `inputs`                                              |
| Contracts      | `inputType` / `outputType`, including declared defaults                                |
| Controllers    | `pkg:cargo/<crate>?local_path=<dir>#<entry>`, `pkg:telo/local/dylib?path=<file>&os=…&arch=…[&libc=…]&abi=telo-<ABI>#<entry>` |

Not supported, each failing with a message that names what is missing rather than degrading quietly: CEL and `!cel`, `variables` / `secrets` / `ports`, transports other than local paths and `oci://` (`https://` imports), private OCI registries, streams, `extends`, template-backed definitions, `Run.Sequence`, every capability other than `Telo.Invocable`, and static analysis.

## Reading a published module

An `oci://host/repo@version#sha256-…` import is read the way `kernel/specs/module-artifact.md` specifies, and the same way the Node kernel reads it:

- **Sources, in order:** a local path; the workspace manifest cache (`<cache-root>/manifests/oci/<host>/<repo>/<version>/telo.yaml`, the file `telo install` writes, falling back to `<entry-dir>/.telo/manifests/`); the registry. A pinned import already in the cache resolves with no network. `<cache-root>` is `TELO_CACHE_DIR`, else the directory holding `telo-workspace.yaml`, else the entry manifest's directory, each followed by `.telo`.
- **Anonymous pulls only.** The registry's bearer-token challenge is answered without credentials, which is what a public registry such as ghcr.io serves. Private registries are not supported: there is no Docker credential chain. A loopback registry host (`localhost`, `127.0.0.0/8`, `::1`) is spoken to over plain HTTP; every other host over HTTPS.
- **Egress policy.** `TELO_EGRESS=public-only` is honoured as in the Node kernel: a host that is, or resolves to, a private, loopback, link-local or carrier-grade-NAT address is refused before any request. It is checked for the registry URL, the token `realm` a registry's challenge names, and every redirect hop (the client follows redirects itself for this; Node checks only the first URL). Unset or `open` means no restriction. It is a guardrail, not isolation: a hostile resolver can answer differently for the check and for the fetch, so network policy remains the boundary.
- **Timeouts.** A connection must be established within 30 seconds and a whole request, body included, must finish within 10 minutes; either failure names the URL.
- **Verification.** The import pin is checked against `telo.yaml` before it is parsed, whether it came from the cache or the registry. A payload layer is fetched by the `blob` digest the pinned `layers:` index names, checked against that digest, then against its `integrity`, then against the entry-path and link rules — all before a byte is written. A pre-layers single-blob artifact still yields its `telo.yaml`.
- **Materialization** extracts into the module's directory beside its cached manifest, restoring execute bits and symbolic links, confined to the real module directory, and records completion last in a `.telo-layer-<role>-<blob>` marker keyed by the blob digest. It holds `<module-dir>/.lock`, the same lock file, body and staleness rule the Node kernel uses, so the two kernels serialize against each other over one cache.

Only controller layers (with the `library` layer of the same selector and the `common` layer) are materialized: this kernel resolves no module-relative files and no native files through an artifact.

## Layout

Files mirror `kernel/nodejs/src/` one-for-one, kebab-case becoming snake_case. That is a rule, not a coincidence: where a file has no counterpart on the other side, one of the two layouts is wrong. Two consequences worth knowing before looking for something:

- **Manifest loading is not here.** It lives in `analyzer/rust`, because that is where it lives in Node — static analysis and the runtime read manifests through one path.
- **`controller_loaders/native_abi.rs` has no Node twin.** It is the host side of the C ABI; the Node.js kernel's equivalent is N-API, supplied by its runtime.
- **`controller_loaders/dylib_loader.rs` and `controller_loaders/purl.rs` have no Node twin.** The first is the artifact branch of Node's `bundle-loader.ts` for the `dylib` format; the second is the PURL grammar Node takes from a library.
- **`manifest_sources/oci_source.rs` has no Node twin.** It is the read half of Node's `transports/oci/oci-transport.ts`; this kernel publishes nothing.

## How a controller is loaded

1. `Telo.Definition` registers the kind with its `controllers:` candidate list. Nothing is resolved yet.
2. On the kind's **first instantiation**, `controller_loader` orders the candidates by the import's `runtime:` policy (this kernel's native PURL type is `pkg:cargo`; `pkg:telo` candidates follow in declaration order) and tries each in turn: `pkg:cargo` goes to `cargo_loader`, `pkg:telo` to `dylib_loader`.
3. `cargo_loader` probes `rustc`, runs `cargo build --release --features telorun-sdk/native`, and reads the built `cdylib` path out of Cargo's JSON message stream.
4. `dylib_loader` takes the `dylib` format only. It matches the candidate's `os` / `arch` / `libc` / `abi` against this host — `abi` is `telo-<TELO_ABI_VERSION>` — **before** fetching anything, so a candidate for another host or another controller ABI is skipped without its layer being downloaded. A matching candidate's controller layer is materialized and `path=` resolved inside it; a module read straight off disk resolves `path=` beside its manifest.
5. `native_abi` opens the library, reads the vtable exported for the PURL's `#fragment`, checks the ABI version, and calls `register` once.

Deferring step 2 to first use is what lets this kernel load an **unmodified** standard-library manifest. `modules/console` declares four kinds and only two have Rust controllers; the other two register fine and fail — naming the kind — only if someone declares a resource of them.

The recoverable/fatal split is the same one `napi-loader.ts` makes: a missing `rustc` is the host's problem and the next candidate is tried; a `cargo build` that ran and failed is the author's code and surfaces immediately, because falling through would mask it.
