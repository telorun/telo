# Lens: Naming — kinds, fields, modules, codes, flags

**Applies to** every name a decision introduces, keeps or inherits: a kind, a named shape, a key,
a CEL root or binding, a module, a diagnostic code, a CLI flag, an env var. A name handed in as
part of an option is a candidate, never a given — it is weighed like any other.

## Principles, in ranking order

1. **The converged term wins.** When established systems — frameworks, standards, languages —
   independently converge on one word for the concept, that word is the name. Rejecting it needs a
   disqualifier below, never a preference.
2. **A collision is exact.** Two names collide only when they are identical in one namespace: two
   kinds of one module, two keys on one object, two codes, two flags of one command. A name sharing
   a word with a key, a CEL root, a protocol term, a field of another kind or a kind of another
   module is not a collision — case, prefix and position already tell them apart.
3. **A collision renames the weaker name, not the concept.** When the converged term truly
   collides, the decision keeps it and renames whichever of the two names is less generic or less
   established, listing that rename under Obligations. Picking a vaguer synonym to dodge an
   existing name is disqualified: backwards compatibility and the shape of existing code never
   count.
4. **Say what it is, not what it holds or how it is built.** A name states the thing declared or
   the operation performed — not the value it exposes, the transport or backend it uses, or a
   generic verb or noun that fits anything (`Data`, `Item`, `Handle`, `Process`).
5. **One concept, one word.** A concept Telo already names keeps that word; a new word for it is
   disqualified. The same word may name related things in different namespaces — a kind, the node
   that places it, the key that references it — which is one concept spelled per position.
6. **Reads right where it is used** — `<Alias>.<Kind>`, `resources.<name>.<field>`, `--flag`, the
   diagnostic a user reads — and is the word a searcher on the hub would type.

## Disqualified

- an exact collision (principle 2) that the decision does not resolve by renaming
- a synonym chosen to avoid an overlap that is not an exact collision
- a backend or implementation name in a generic kind, field or module
- wording that only makes sense against history (`new`, `v2`, `legacy`, `unlike before`)
- broken case rules (PascalCase types, camelCase values), a CEL keyword, or a diagnostic code not
  spelled `<SUBJECT>_<PROBLEM>`

## Distinguishing questions

1. Do established systems converge on a word for this concept? Which, and which systems?
2. Is there an identical name in the identical namespace — or only a shared word elsewhere?
3. If identical: which of the two is less generic, and what does it become?
4. Does the candidate name the thing, or what it holds, how it travels, or what it replaced?

## Horizon

A second transport behind the same kind · a hub searcher who never saw Telo · the visual editor's
palette listing the kind beside its siblings · a second module adopting the same concept.

## Verify

1. Every name the decision keeps or coins is the converged term where one exists, or states why
   none does.
2. Every rejection on collision names the identical name and namespace it collides with.
3. No chosen name is a synonym picked to avoid a word used elsewhere in Telo.
4. Every rename a collision forces is listed under Obligations.
