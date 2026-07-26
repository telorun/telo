---
"@telorun/analyzer": minor
---

Add the `x-telo-value-schema-from` schema annotation.

The value at an annotated node must satisfy the type declared at the resource's
named field, resolved with the same `telo#Type` semantics as `inputType` /
`outputType`. It targets kinds with ONE declared output contract and SEVERAL
slots that must each produce it — a decision table's rows, a switch's arms —
where only the branch that wins at runtime would otherwise ever be checked, so a
mistyped branch ships and fails on the one input that selects it.

CEL leaves are replaced with schema-shaped placeholders before validation, so an
expression is accepted wherever its declared type would be; what the check
catches is structural disagreement no runtime value could fix. A field that
resolves to no schema is skipped — declaring the contract is what opts in.
Generic and topology-driven: no resource kind is hardcoded.
