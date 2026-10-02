---
"@telorun/templating": minor
---

`parseJson` and the regex functions (`regexReplace`, `regexExtract`, `regexExtractAll`, `regexGroups`) now refuse in Telo's own words instead of the JS engine's and the regex library's: invalid JSON is `parseJson: invalid JSON at offset <n>` (ending ` (unexpected end of input)` for a truncated text), and an invalid pattern is `<fn>: invalid RE2 pattern "<pattern>": <kind>` with `<kind>` one of RE2's parse-error kinds and no quoted fragment after it. Breaking: a regex pattern or flags argument written as a literal is now checked statically, so an invalid literal pattern or an unknown literal flag is refused at `telo check` (`CEL_INVALID_ARGUMENT`) where it used to fail only when evaluated. `re2js` (2.8.3) and `uuid` (14.0.1) are now exact dependencies rather than ranges, so the package's regex and UUID answers are pinned to the versions the conformance vectors ran against.
