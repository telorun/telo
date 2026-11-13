# Capability conformance vectors

What a `capability:` value on a `Telo.Definition` / `Telo.Abstract` means, frozen as data: every runtime that judges one — `telo check` and both kernels — reads `vectors.json` and answers each row identically, word for word. Editing one expected message breaks every runner until each implementation says it.

## Format

`vectors.json` is one object, `{ "rows": [ … ] }`. Each row:

- `id` — unique, `<outcome>/<case>`.
- `capability` — the value the document declares, any JSON value. Absent means the document declares no `capability:`.
- `extends` — `true` when the same document declares `extends:`.
- `code` — the refusal: `CAPABILITY_UNKNOWN` or `CAPABILITY_NOT_DECLARABLE`, or `null` when the value is accepted.
- `message` — the refusal's text, exactly; `null` when accepted.

A load refuses it through its analysis, as one `ERR_MANIFEST_VALIDATION_FAILED` carrying the diagnostic, whose message is `Telo.Definition '<name>': <message>` (`Telo.Abstract` for an abstract); the Node kernel's registration guard, the backstop for a definition no analysis read, raises it as `ERR_<code>` with the same message.

## Runners

- `analyzer/nodejs/tests/capability-roster.test.ts` — the roster's reader, `telo check`'s half.
- `kernel/nodejs/tests/capability-roster.test.ts` — the Node kernel's registration guard.
- `analyzer/rust/src/capability_roster.rs` (tests) — the Rust analyzer's reader.
- `kernel/rust/tests/capability_roster.rs` — the Rust kernel's load, which refuses a definition's `capability:` through its analysis, as one `ERR_MANIFEST_VALIDATION_FAILED` carrying the row's code and `Telo.Definition '<name>': <message>`. It refuses every `extends:` on its own (`ERR_UNSUPPORTED_MANIFEST_FEATURE`), after the analysis, so an accepted row with `extends: true` is held only to carrying no capability diagnostic. A row whose value the load's migration rewrites (`capability: <Alias>.<Kind>`) never reaches the roster at load, and is held to the same.

The vectors are not built-in vocabulary: nothing under `sdk/builtins/` reads them, and no runtime ships them.
