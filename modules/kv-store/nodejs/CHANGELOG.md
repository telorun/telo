# @telorun/kv-store

## 0.3.0

### Minor Changes

- e52a2bf: Declare a `source` export condition naming the TypeScript each entry is built from, ahead of `import`.

  These are pure TS libraries that get inlined into each consuming module's controller bundle. Resolving that inline through `dist/` would make building a controller depend on having first built every library it inlines — which is the build step bundled delivery exists to remove, and which fails outright on a fresh clone. A bundler asked for `--conditions=source` now takes the source; every other consumer resolves to `dist/` exactly as before.

## 0.2.0

### Minor Changes

- adc8459: Initial release: the `KvStore.Store` contract plus `KeyedClaim`.

  `KvStore` is four conditional-write primitives — `get`, `putIfAbsent`,
  `compareAndSet`, `compareAndDelete` — over an opaque revision token. `KeyedClaim`
  implements the claim → renew → settle | release protocol once on top of them, so
  `Lease.Critical` and `Idempotency.Once` share one state machine instead of each
  backend re-expressing the same ownership guard in JavaScript, SQL, and Lua.
