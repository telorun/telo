---
"@telorun/kernel": patch
---

Telo editor now renders schema string fields as a Monaco code editor when the field carries `x-telo-widget: "code"`, with syntax highlighting resolved from the field's `contentMediaType` via Monaco's own language registry. No built-in language table lives in the editor — modules declare their own format entirely through schema annotations, so new languages land without editor changes.

- New recognized schema annotation `x-telo-widget` — registered in the kernel's AJV vocabulary. Accepts `"code"` today; orthogonal to `contentMediaType`, which carries the MIME.
- `Javascript.Script.code` now declares `x-telo-widget: "code"` + `contentMediaType: "application/javascript"` and renders in Monaco with JS highlighting.
- Composes unchanged with `x-telo-eval`: the CEL toggle wraps whichever inner widget the schema selects — typed-value mode shows the code editor, CEL mode shows the existing expression input.
