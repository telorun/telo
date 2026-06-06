---
"@telorun/templating": minor
"@telorun/kernel": patch
---

Expand the CEL stdlib:

- **Time:** `nowIso(tz?)` (ISO-8601, UTC by default or in an IANA timezone), `today(tz?)` (`YYYY-MM-DD` in that zone), `nowMillis()` / `nowSeconds()` (absolute epoch int).
- **UUID:** `uuidv1/3/4/5/6/7()`, `uuidValidate(s)`, `uuidVersion(s)`.
- **Strings:** `lower`, `upper`, `trim`, `replace(s, old, new)`, `split(s, sep)`.
- **Math:** `abs`, `floor`, `ceil`, `round`, `min(list)`, `max(list)`.
- **Collections:** `distinct`, `sort`, `reverse`, `flatten`.
- **JSON / encoding:** `parseJson(s)`, `base64Encode/Decode`, `urlEncode/Decode`.
- **Hashing:** `md5`, `sha1`, `sha512`, `hmac(algorithm, key, message)` (host-injected alongside `sha256`).
- **Null handling:** `default(value, fallback)`, `coalesce(list)` — CEL has no `??`.

Time/UUID/`nowMillis` are non-deterministic: in an `x-telo-eval: compile` field they bake once at load; use a runtime field for a fresh value per evaluation. Hashing and base64 are host-injected to keep `@telorun/templating` browser-safe (the kernel supplies Node `crypto`/`Buffer`); `buildCelEnvironment` now accepts a partial handler map. Adds `uuid` as a dependency.
