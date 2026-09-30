# Lens: Domain-driven design

**Applies to** what a boundary contains: which concepts, which rules, which consistency guarantees.
Builds on the architecture lens (where boundaries go) and the data-modeling lens (how data is
stored).

## Principles, in ranking order

1. **A bounded context is the architecture lens's cohesion unit.** A context may span several
   components; a component never spans two contexts. Whether a context runs as one service or
   several is a scaling question, not a modelling one. In Telo a context is a module or a set of
   modules, and a Library's `exports` is its published language.
2. **Each context owns its own model** of a shared real-world thing, in its own language — billing's
   customer, not the customer. Contexts exchange IDs and facts through contracts and translate at
   the boundary (anti-corruption layer; in Telo, an abstract with an implementation behind an
   import). No canonical model shared across contexts.
3. **One transaction changes exactly one aggregate.** Aggregates reference each other by ID only.
   An invariant needing two records at once makes them one aggregate. Rules spanning aggregates
   become consistent afterwards through domain events. An aggregate is as small as its invariants
   allow. In Telo an aggregate's write is an atomic execution zone (`Sql.Transaction`); a value
   object is a `Telo.Type`.
4. **Strategic DDD everywhere, tactical DDD only where business invariants exist.** Every component
   belongs to one context and speaks its language. Aggregates and domain events where rules must
   hold across records or over time; plain CRUD where data has only integrity rules.
5. **Each context keeps a glossary of its terms**, and code, contracts and events use exactly those
   words.

## Distinguishing questions

1. Which context does this belong to — and does it span two?
2. Does the data carry business invariants, or only integrity rules?
3. Must a rule hold across these records at every moment, or may it become consistent afterwards?
4. Does an event stay inside the context, or cross to another?

## Consequences

- **Spans two contexts** → split it; each context models its own part.
- **Business invariants** → an aggregate whose root enforces them through its operations. A model of
  plain fields with the rules in handlers is disqualified. Writing an aggregate's inner records
  other than through its root is disqualified. **Integrity rules only** → plain CRUD; aggregates
  there are disqualified as concepts that model nothing.
- **Holds at every moment** → one aggregate. **May converge** → separate aggregates joined by
  domain events.
- **Stays inside** → a domain event, free to change. **Crosses** → a separate, stable integration
  event the owner translates into. Other contexts subscribing to internal domain events is
  disqualified — every internal refactor would break them.

**Always:**
- Importing another context's model types or using its terms is disqualified; translate at the
  boundary.
- Events are past-tense facts (`InvoiceIssued`); commands are imperative and addressed to one owner.
  An event named as a command is disqualified.
- Domain values (email, amount, quantity, date range) are value objects validated once at
  construction, serialized to primitives across a boundary and re-validated on receipt. Raw
  primitives for them are disqualified.
- Names come from the domain experts' language and the glossary. Technical or empty names
  (`OrderManager`, `ItemData`, `processRecord`) where the domain has a word are disqualified.

## Horizon

A second context needing the same real-world thing · an aggregate moved to its own store or service
· a second subscribing context · concurrent writers on a busy aggregate · a new invariant.

## Verify

1. Every component belongs to exactly one context; none imports another context's model types.
2. Every transaction writes exactly one aggregate.
3. Every invariant is enforced inside its aggregate root; nothing writes an aggregate's inner
   records directly.
4. Published events are past-tense integration events; an internal event changes without any
   subscriber noticing.
5. Names in code, contracts and events match the context's glossary.
