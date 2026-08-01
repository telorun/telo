---
"@telorun/ai": minor
"@telorun/cache": minor
"@telorun/embedding": minor
"@telorun/sql": minor
"@telorun/vector-store": minor
---

Drop the controller entry points from the export map; the package is now the TS contract only.

Each of these modules delivers its controllers as bundles inside its own module artifact, so the per-controller subpath exports (`./lookup`, `./connection`, …) no longer point at anything a consumer should import. What remains is the surface a third-party backend of the module abstract compiles against — the store / connection / model contracts and their helpers — which is exactly why the package keeps publishing rather than going private like the rest of the standard library.

Each export also gains a `source` condition naming the TypeScript it is built from, ahead of `import`. A consumer resolving normally still gets `dist/`; a bundler asked for `--conditions=source` inlines the source instead, which is what lets a controller that inlines this package be built without first building it.
