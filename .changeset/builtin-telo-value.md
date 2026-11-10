---
"@telorun/sdk": minor
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

`Telo.Value` is a built-in kind: an invocable that returns a value shaped from its inputs and optional named bindings, checked against its `inputType` and `outputType`, with no import. It answers exactly as `Run.Value` does, listed by `telo builtins`. The Rust kernel refuses it as it does the other CEL-evaluating built-ins.
