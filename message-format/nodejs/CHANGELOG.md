# @telorun/message-format

## 0.124.0

## 0.123.1

## 0.123.0

## 0.122.0

## 0.121.0

### Minor Changes

- a6d17ff: New package `@telorun/message-format` (with its Rust twin `telorun-message-format`): Telo's message core. It reads a closed profile of Unicode MessageFormat 2 — text with `{$name}` placeholders and the escapes `\{`, `\}`, `\\`, and plural selections `{ plural: count, cases: { "=0": …, one: …, other: … } }` that nest — into a plain-JSON model, and identifies a source text by its all-`other` pattern plus its context. It finds a catalog language by RFC 4647 lookup (`pl-Latn-PL` → `pl-Latn` → `pl`). It formats numbers and selects plural categories from pinned CLDR 48.2 data for every locale, using no `Intl`, so Node, Rust and the browser give the same answer. A number's text depends on its value alone: int64 and uint64 are written exactly, and a double is rounded half-to-even to the language's pattern. `@telorun/sdk` now depends on the core and re-exports it.
