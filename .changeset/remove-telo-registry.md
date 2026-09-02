---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
"@telorun/runner-core": minor
"@telorun/ide-support": patch
"@telorun/k8s-runner": minor
---

Remove the Telo HTTP registry. Modules resolve over `oci://` and direct `https://` URLs only; the bare `<namespace>/<name>@<version>` ref form and the `registry.telo.run` origin are gone.

**Breaking.** A manifest whose `imports:` names a bare ref no longer resolves — rewrite it to the module's `oci://` ref. `--registry-url` (run / check / install / upgrade / migrate / module), `--registry` (publish), `TELO_REGISTRY_URL` and `TELO_REGISTRY_TOKEN` are removed, as is `Kernel`'s `registryUrl` option; `defaultTransports` / `defaultTransportRegistry` / `defaultSources` take no argument. `RegistryTransport` becomes `HttpTransport` — it keeps direct `https://` module URLs and the `.telo/manifests/url/…` cache subtree, and enumerates no versions. `RegistrySource`, `parseModuleRef` and `isRegistryRef` are removed from `@telorun/analyzer`, and `withRefVersion` now accepts only `oci://` refs. The `registry/<host>/…` manifest-cache subtree is no longer written or read. `SessionConfig.registryUrl` leaves the runner `/v1` contract, `sessionConfigSchema` loses its `registryUrl` option, and the k8s chart drops `build.teloRegistryUrl` (which also changes every per-app image tag, since the registry URL was a digest input).
