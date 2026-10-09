---
"@telorun/analyzer": minor
---

A CEL binding typed from a sibling reference (`x-telo-context-ref-from`) reads that reference on the object holding the annotated field, and nowhere else. A context declared on a field of a plain nested object is therefore typed — `approver.invoke` for a context on `approver.result` — where the binding used to be left open: a misspelled member (`result.verdct`) and a leaf of the wrong type passed `telo check`. A mapping that was open can now be refused. Hover and go-to-declaration on such a binding resolve the same way. A context on a nested object that read its reference on the enclosing array item is no longer typed from it.
