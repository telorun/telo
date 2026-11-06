---
"@telorun/analyzer": minor
---

Resource rules gain `coReferrers:`, so a kind can refuse two of its resources claiming one thing on a target they share.

- **`coReferrers: /<slot>`** names one reference slot of the declaring kind. The condition then reads `coReferrers`: every other resource of that kind, or of a descendant inheriting its rules, whose slot there names the same declaration. Each is bound as a referrer rule binds its co-referrers, with its references resolved one level. Two session sets with one `name` on one store is the case it was built for, written `!coReferrers.exists(o, o.name == self.name)`.
  - The check is declared by the claimant, so the shared kind — usually another module's store — names none of its consumers.
  - When `self`'s slot names nothing the analysis can compare (a library's kind-only `resources:` input, a reference to nothing loaded, an expression), the rule is `RESOURCE_RULE_SKIPPED` wherever the condition reads `coReferrers`. It is never a pass.
  - A pointer naming a plain field or a collection is `RESOURCE_RULE_INVALID` at the kind.
  - The rule runs once per resource, and an empty set is a pass. Each set is built once per kind, slot and target, so the cost stays linear in the resources analysed. A `base:` child inherits no rule and joins no set.
- **A referrers read may now stand inside a reference read** in the places a check declares it reads. A per-configuration judgement of a rule reading through a shared target is then keyed on that target's referrers.
