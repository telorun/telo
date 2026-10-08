---
"@telorun/analyzer": minor
---

A resource rule whose `in:` or `resolve:` pointer names a field the kind inherits is accepted wherever the parent is declared. Before, the pointer resolved only when the parent kind was registered ahead of the child, so a rule over a field inherited from a kind declared later in the same file, or in an imported module, was reported as `RESOURCE_RULE_INVALID` ("which this kind's schema does not declare") by `telo check` on the declaring library.
