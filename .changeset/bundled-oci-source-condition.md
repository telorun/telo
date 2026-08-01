---
"@telorun/codec": minor
"@telorun/kv-store": minor
---

Declare a `source` export condition naming the TypeScript each entry is built from, ahead of `import`.

These are pure TS libraries that get inlined into each consuming module's controller bundle. Resolving that inline through `dist/` would make building a controller depend on having first built every library it inlines — which is the build step bundled delivery exists to remove, and which fails outright on a fresh clone. A bundler asked for `--conditions=source` now takes the source; every other consumer resolves to `dist/` exactly as before.
