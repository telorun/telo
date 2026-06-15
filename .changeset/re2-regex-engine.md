---
"@telorun/templating": minor
---

Move the CEL regex functions onto the RE2 contract. `regexReplace`,
`regexExtract`, `regexExtractAll`, and `regexGroups` are now backed by
[`re2js`](https://github.com/le0pard/re2js) — a pure-JS port of Google's RE2 —
instead of JS `RegExp`. Because it's pure JS (no native addon), regex behaves
identically under Node, Bun, and the browser, with RE2 semantics: linear-time,
no backtracking (ReDoS-safe), inline `(?s)` and `$1` replacement backrefs, and
the `i` / `m` / `s` flags. The three extract functions gain an optional trailing
`flags` argument.
