---
"@telorun/sdk": minor
"@telorun/kernel": minor
"@telorun/test": minor
"@telorun/assert": minor
---

Controllers that need to run or analyze another manifest now ask the host for a
kernel instead of importing one.

`ResourceContext.createKernel(options?)` (SDK-declared, kernel-implemented)
returns a fresh, fully isolated `Kernel` — its own controller registry, event
bus, and lifecycle — that resolves manifest URLs through the **host's**
`ManifestSource` chain and, unless overridden, inherits the host's streams and
environment. `registryUrl` is deliberately not inherited; the child resolves
registry refs through the default sources.

`Kernel.analyze(url)` joins the SDK's `Kernel` interface as the non-throwing
counterpart to `load()`: it returns every diagnostic the static analysis
produced — both `error` and `warning` severities, including the loader's
version-reconciliation diagnostics — rather than throwing on the first error. A
file that fails to parse short-circuits to its `MANIFEST_PARSE_FAILED`
diagnostics, since analyzing a mangled parse tree buries the real error under
spurious secondaries (the same policy `telo check` applies). It runs against
fresh registries and writes no cache, so it never mutates the kernel it is
called on. A graph that cannot be loaded at all still throws.

`@telorun/test` and `@telorun/assert` are the first consumers: `Test.Suite`
drops its `@telorun/kernel` dependency and `Assert.Manifest` drops
`@telorun/analyzer` (along with its hand-rolled duplicate of the kernel's
`LocalFileSource`). Both controllers now depend only on `@telorun/sdk`, so they
bundle as `pkg:telo` artifacts like every other module instead of inlining a
second copy of the runtime.

Two behaviour changes fall out of this:

- Test manifests resolve through the host kernel's full source chain instead of
  a bare `LocalFileSource`, so a test can now reference registry modules and the
  local manifest cache.
- `Assert.Manifest` sees YAML parse failures as `MANIFEST_PARSE_FAILED` error
  diagnostics, and version skew as `MODULE_VERSION_CONFLICT` /
  `MODULE_VERSION_HOISTED`; previously a fixture with malformed YAML or an
  incompatible major skew produced no diagnostics at all.
