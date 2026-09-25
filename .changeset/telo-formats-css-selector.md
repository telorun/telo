---
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

Added: Telo validating formats, starting with `format: css-selector` — a Selectors Level 4 selector list without pseudo-elements, namespace prefixes or a leading combinator, with `:scope` for the element it is matched from. A relative selector (`+ p`, `> a`) is accepted only inside `:has()`, `:has()` does not nest, and `:nth-child()` / `:nth-last-child()` take a selector list after `of` (`:nth-child(odd of .a, .b)`). The vocabulary is data in `analyzer/formats/`, with a conformance set every runtime's checker must agree with, and every analyzer and kernel validator checks it, including validators served from the kernel's on-disk cache, whose key covers the format vocabulary. A value outside the grammar is refused with the position and the expected token (`/selector must be a css-selector: Expected attribute name at offset 3 of "div["`), identically by `telo check` and by the kernel. A `!cel` or `!interpolate` value at such a slot is typed as a string by `telo check`, and its result is checked at creation, or at dispatch for a call's `inputs:`; a result that is not a string at all is refused at creation, naming the field.
