---
"@telorun/analyzer": minor
---

Added: a resource rule may declare `resolve:`, a list of JSON Pointers to its kind's own reference slots. Inside the condition each one reads as the declaration it references, one level deep: a single slot as that declaration, a collection of references as the same collection with each entry resolved. This lets a rule state a relation across the resources a slot lists, such as distinct language codes. When a reference cannot be resolved, or names a library's kind-only `resources:` input, the rule reports `RESOURCE_RULE_SKIPPED` for that resource instead of running over a partial set. The same kind-only case now skips a referrer rule's `peers:` binding too, where it used to bind a declaration with no fields. A `!module-path` inside a bound declaration now compares as the path its author wrote; it used to make every rule binding that declaration skip.
