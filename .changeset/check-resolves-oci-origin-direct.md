---
"@telorun/kernel": minor
"@telorun/cli": minor
---

`telo check` now resolves every import scheme the runtime does — `oci://`
included — and reports locations as CWD-relative paths.

`check` built its loader from the analyzer's browser-safe `defaultSources()`
(HTTP + registry only), so an `oci://` import failed with "No source found for".
It now uses the kernel's `defaultTransportRegistry(registryUrl).sources()` — the
same origin-direct chain `install` / `run` use — so OCI resolves straight from
the origin registry, never through the hub cache (the discovery plan's invariant:
CLI resolution never routes through the hub; the `manifests.telo.sh` cache is the
browser editor's read path only). A `--registry-url` option is added, matching
the `--registry-url → TELO_REGISTRY_URL → https://registry.telo.run` fallback of
`run` / `install` / `upgrade`.

Diagnostic locations for on-disk manifests are now printed relative to the
working directory (e.g. `examples/hello-world/telo.yaml:12:12`) instead of an
absolute `file://` URL; genuine `http(s)://` sources stay absolute.

`@telorun/kernel` gains a `./transports` subpath export (re-exporting
`defaultTransportRegistry` and the transport registry) and a
`./manifest-sources/local-file-source` subpath so a Node consumer can pull just
the transport-resolution sources and the local-file source without the
controller/bundler machinery the package root drags in. `telo check` and the VS
Code host both import through these subpaths.
