# Capability conformance vectors

What a `capability:` value on a `Telo.Definition` / `Telo.Abstract` means, frozen as data: every runtime that judges one — `telo check` and both kernels — reads `vectors.json` and answers each row identically, word for word. Editing one expected message breaks every runner until each implementation says it.

## Format

`vectors.json` is one object, `{ "rows": [ … ] }`. Each row:

- `id` — unique, `<outcome>/<case>`.
- `capability` — the value the document declares, any JSON value. Absent means the document declares no `capability:`.
- `extends` — `true` when the same document declares `extends:`.
- `code` — the refusal: `CAPABILITY_UNKNOWN` or `CAPABILITY_NOT_DECLARABLE`, or `null` when the value is accepted.
- `message` — the refusal's text, exactly; `null` when accepted.

A kernel raises the refusal as `ERR_<code>`, its message `Telo.Definition '<name>': <message>` (`Telo.Abstract` for an abstract).

## Runners

- `analyzer/nodejs/tests/capability-roster.test.ts` — the roster's reader, `telo check`'s half.
- `kernel/nodejs/tests/capability-roster.test.ts` — the Node kernel's registration guard.
- `analyzer/rust/src/capability_roster.rs` (tests) — the Rust analyzer's reader.
- `kernel/rust/src/controllers/resource_definition/resource_definition_controller.rs` (tests) — the Rust kernel's registration. It refuses every `extends:` on its own (`ERR_UNSUPPORTED_MANIFEST_FEATURE`), after the roster, so an accepted row with `extends: true` is held only to raising no `ERR_CAPABILITY_*`.

The vectors are not built-in vocabulary: nothing under `sdk/builtins/` reads them, and no runtime ships them.
