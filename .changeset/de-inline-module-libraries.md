---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

A module-owned library is resolved at load through the import graph instead of
being copied into every dependent's controller bundle, and a module builds one
bundle rather than one per kind.

Both halves fix the same defect: a bundle is a module graph, so a shared source
file compiled into two bundles is two module scopes, and any state a module keeps
beside its instances — a registry, a `WeakMap`, a counter — silently becomes two
of them. `sql` had six controller bundles and therefore six copies of its
connection registry.

- A module's kinds now select their controllers out of its single bundle with the
  PURL fragment (`…&local_path=./nodejs/src/index.ts#SqlQueryController`).
- A `Telo.Library` may declare `exports.code:` — entries naming the bare
  specifier dependents import it by and the file that resolves to
  (`{ specifier, format, path, source }`, plus `os` / `arch` / `libc` for a
  native entry). The kernel joins that to the consumer's `imports:` during
  `load()` and resolves the import to that module's own entry point.
- The artifact spec gains a `library` layer role, per selector, carrying that
  entry point; a file claimed as both a controller and a library entry ships in
  the library layer, and materializing either code role pulls both plus `common`.
- Three build-time guards keep the property from decaying: importing a subpath of
  a declared specifier, reaching a declared library's entry-source directory by
  any other route, and inlining a module-owned library the manifest never
  declared an import for — each a hard build error rather than a silent extra
  copy. The last is the one that matters most: the other two are derived from the
  `imports:` edges, so they are vacuous exactly where the mistake is made.
- An unknown layer role in a published index is now skipped rather than rejected,
  so a module that gains a layer for a newer runtime does not become unreadable
  on an older one.

Deduplication is per (module, resolved version): two dependents pinning different
versions of one library still resolve two copies — that is different code — and
the kernel warns rather than pretending otherwise.
