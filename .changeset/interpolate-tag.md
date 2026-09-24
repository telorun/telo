---
"@telorun/templating": minor
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/ide-support": minor
"@telorun/cli": minor
"@telorun/debug-wire": patch
"@telorun/debug-ui": patch
---

Added: the `!interpolate` tag — literal text with `${{ expr }}` holes, always a string. Its meaning is exactly the CEL expression joining the text with `string(<hole>)` for each hole, so a hole converts through CEL's own overloads (RFC 3339 for a timestamp, UTF-8 for bytes) rather than the host's. `telo check` type-checks each hole, reports one whose type CEL cannot convert to text as `INTERPOLATION_HOLE_NOT_CONVERTIBLE` and a nullable one as `CEL_NULLABLE_ACCESS`, and checks the result against the field like any other string — an integer field is a type mismatch, a `Telo.HostPath` field `HOST_PATH_UNTYPED_SOURCE`. A `dyn` hole that is null, a list or a map at runtime fails with `ERR_INTERPOLATION_HOLE_NOT_CONVERTIBLE`, naming the hole. `!sql` and `!interpolate` read holes with one grammar that understands CEL string literals, so a hole may hold a map literal or a string containing `}`, and `${{ '${{' }}` yields a literal `${{`. The CEL catalog gains `string(duration)`, rendering the `Telo.Duration` plain encoding (`5400s`, `1.5s`), and a value brand whose base is not a string renders as text statically too, so `string(ports.http)` and a port in a hole type-check.

Added: `TemplatingEngine.expressionRegions(source)` says where a tag's CEL sits — the whole `!cel` scalar, each hole of a tag with holes — and `celExpressionsOf(engine, source)` reads it; editors colour, complete, hover and rename inside the holes of any tag through it. The migration vocabulary gains `match.scalar` (`lone-hole` | `interpolated`, an untagged string scalar by its text; a core entry may pair it with `inKind` / `under` `*`) and `set-tag`'s `source: text | hole`.

Changed: a plain string holding `${{` is no longer an expression. The core migration `untagged-interpolation` rewrites it at load — a lone hole to `!cel "<expr>"`, text with holes to `!interpolate` with the text unchanged — and reports `DEPRECATED_UNTAGGED_INTERPOLATION` in the entry module's own files; `telo migrate` writes the same rewrite to disk. One read without migrations, or a `${{` no hole can be read out of, is refused: `UNTAGGED_INTERPOLATION` at `telo check` — in an imported library, at the consumer's import of it — and `ERR_UNTAGGED_INTERPOLATION` at load. Under `!interpolate` a hole that is null at runtime is an error where the untagged form printed an empty string. `compileString`, `toParameterized`, `TEMPLATE_REGEX`, `EXACT_TEMPLATE_REGEX` and `CompiledValue.parts` are removed; `readInterpolationHoles` / `interpolationShape` replace them.

Changed: a deferred runtime expression in a `Created` event's `properties` — and in an expression failure's message — is rendered as the tag it was written with (`!cel "request.body"`, `!interpolate "hi ${{ name }}"`) rather than as `${{ source }}`.
