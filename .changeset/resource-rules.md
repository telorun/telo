---
"@telorun/analyzer": minor
---

`x-telo-resource-rules` — a kind declaring, as data, relationships between the
fields of ONE resource that JSON Schema cannot state: an index naming a column
its table does not declare, a foreign key whose two sides differ in length, a
`renamedFrom:` pointing at a column the table still declares. Every rule of that
form was previously a controller guard at boot, which needs a database to run at
all, fires in several cases only after an earlier phase has already changed it,
and is invisible to the editor.

The predicate is CEL rather than a closed vocabulary of named rules. Correlating
two collections — a foreign key's own columns against its own references, not
every other key's — is the part a pointer language gets wrong, and a
comprehension closure gives it for free; `"id" in self.columns` reads map keys,
so a `*`-means-keys grammar never arises. The vocabulary is borrowed from
`Telo.JsonSchema.rules` (`condition` TRUE when the rule HOLDS, the subject bound
as `this`, plus `code` and `message`), because two CEL rule vocabularies with
opposite polarity is a trap an author falls into once per rule.

`in:` names the collection to iterate and IS the diagnostic's anchor, so a
reported path exists by construction; omitting it gives the whole-resource form
that a `severity: warning` on a discouraged value wants. Violations report under
one analyzer-owned `RESOURCE_RULE_VIOLATED` with the author's code in
`data.rule`, keeping the diagnostic-code namespace closed.

Both ways coverage can vary invisibly are reported rather than dropped:
`RESOURCE_RULE_SKIPPED` when a value the condition reads holds a `!cel`
expression (per element, narrowed to the nodes the condition actually reads), and
`RESOURCE_RULE_UNEXERCISED` when a rule's collection was empty on every resource
of its kind. Rules may not call host-backed or non-deterministic functions, and
are budgeted at 50 ms per resource. Guide: `docs/extend/resource-rules.md`.
