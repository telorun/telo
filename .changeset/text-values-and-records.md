---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/ide-support": minor
---

The text walk records a text only where its fragment admits the value: a string where the fragment takes one, an object only when it holds every required member of one of the fragment's closed object branches and nothing else. A `Text` that is one alternative of a union beside an object shape — a text, or a text with values of its own — is therefore read by the branch that holds it in both halves; before, the kernel judged the whole object as a `Text` and refused it at boot (`ERR_MESSAGE_SYNTAX_INVALID`) while `telo check` was silent. An expression at such a union is evaluated first and its result read by the same rule.

New annotation `x-telo-text-values: { <name>: <schema> }` on a `Text` or `Message` node declares the values whoever shows the text formats it with (`{}` for none). A placeholder or plural selector the text reads that is not declared is `MESSAGE_PLACEHOLDER_UNBOUND`, and a selector over a value declared as a string `MESSAGE_PLACEHOLDER_VALUE_UNSUPPORTED` — by `telo check` for a literal text, by the kernel for a text an expression computes (`ERR_`-prefixed). The annotation on a node that is no text, naming a value typed as neither a string nor a number, or on a text a values pairing (`x-telo-text-values-for`) already binds is `TEXT_VALUES_INVALID` — at the kind, at the import reaching a dependency's, and when the kernel registers the definition (`ERR_TEXT_VALUES_INVALID`). Completion offers it in a kind's schema and in a data schema. The analyzer exports `textValuesProblems`, `judgeDeclaredValues`, `declaredValueKinds`, `fragmentAdmits` and `declaredTextValuesOf`.

New built-in fragment `telo://manifest#/$defs/TextRecord`: the closed record `{ text, context, lang, computed }` a controller receives for a `Text`, for a schema typing text that is already a record (a renderer's wire, a controller forwarding what it received). The text walk never enters one.
