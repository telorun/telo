---
"@telorun/cel": minor
"@telorun/sdk": minor
---

Durations accept the units `d` (24 hours) and `w` (7 days), in CEL's `duration()` and in every `Telo.Duration` slot, in the Node and Rust runtimes alike: `ttl: 30d`, `duration('1w')`, `1d12h` and `1.5d` all read. Months and years stay out, having no fixed length. A duration still prints in seconds (`86400s`). The Rust plain-encoding reader now uses the same grammar as Node, so text such as a bare `s` with no number is refused there too.
