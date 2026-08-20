---
"@telorun/sdk": minor
"@telorun/kernel": minor
"@telorun/analyzer": minor
---

Declarative SQL schema support.

- **SDK**: the duration grammar gains a day unit (`30d`), so a grace window can be
  written as one, and its error message lists it. Grace windows are measured in days and every other duration in
  the runtime already goes through this one parser.
- **Kernel**: member access on a resource instance reads its **published state**.
  A ref slot holds the live instance after Phase-5 injection, which CEL cannot
  read a member off at all, so a template body could not read a scalar off a
  resource it references. `self.<ref>.<field>` now answers exactly as
  `resources.<name>.<field>` does — the same fact, the same reading. A whole-value
  `${{ self.connection }}` is unchanged: that form is navigated directly and still
  yields the instance itself.
- **Analyzer**: `x-telo-schema-map` / `x-telo-schema-projection` let a kind whose
  configuration is a collection of typed entries declare what that collection
  means as a JSON Schema object, and `x-telo-schema-projection-from` lets a
  consumer type a slot from the declaration it references. Generic over typed-field
  declarations — nothing in them says SQL, column or table. `SCHEMA_PROJECTION_INVALID`,
  `SCHEMA_MAP_INCOMPLETE` and `SCHEMA_PROJECTION_FROM_UNRESOLVED` report a projection
  that would silently type nothing — on the declaring side and the consuming side
  alike, since the consuming side is where the typing is actually wanted.
