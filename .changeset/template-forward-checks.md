---
"@telorun/analyzer": minor
---

Check a value forwarded through a template body as the entry's own field

A template body that hands a value to an entry with a bare `!cel "self.<path>"`
(`routes: !cel "self.workflows"`) gives the entry exactly what the consumer wrote,
and the entry validates it at boot. `telo check` validated only the enclosing
kind's own schema, so a forwarded route with `status: notanumber` checked clean
and failed at boot with the router's `ERR_INVALID_VALUE`. Now each such value is
checked as a field of a resource of the entry's kind — its schema (with
`x-telo-schema-from` resolved), its reference slots and their `inputs:`, and its
CEL in the entry's contexts — and every finding is reported on the consumer's own
line (`workflows[0].returns[0].status`). A forwarded expression is typed where it
is evaluated, so a wrapper no longer needs to restate the entry's `x-telo-context`
blocks for its consumers' CEL to be checked.

New diagnostic `TEMPLATE_FORWARD_INCOMPATIBLE`: the schema a templated kind
declares for a path it forwards is not assignable to the entry field receiving it.
