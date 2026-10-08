---
"@telorun/analyzer": minor
"@telorun/kernel": minor
---

**A template body's bare `self.<path>` may continue past a reference slot.** `model: !cel "self.model.schemas.list"`, where `model` references a resource whose own `schemas.list` is a reference, hands the entry what that resource was declared with there — the live instance for a reference, the value for plain data. The kernel continues in the referenced resource's declaration wherever its instance has no such member; before, the path yielded nothing and the entry failed creation as missing a required field. `telo check` builds the same view — the forwarded value is checked as the entry's own field and reported at the reference the consumer wrote — when the referenced resource is declared in the consumer's own module, and `TEMPLATE_FORWARD_INCOMPATIBLE` judges such a path against the schema of the kind the slot names.

**A rule's `resolve:` reads a named shape with its parents folded in.** In `x-telo-resource-rules` and `x-telo-referrer-rules`, a referenced `Telo.JsonSchema` declaring `extends:` binds with the inherited properties and `required` in its `schema`, as every other reader of a shape sees it. A rule such as `this.property in self.model.schema.properties` reported an inherited property as undeclared; it no longer does.
