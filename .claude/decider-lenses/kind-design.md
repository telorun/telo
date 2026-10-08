# Lens: Kind design — variants, discriminators, shared keys

**Applies to** the shape of the manifest surface: what becomes a kind, a field or a named shape,
and how alternatives of one concept are spelled. Builds on the architecture lens (declared seams,
the generic side never names the specific one).

## Principles, in ranking order

1. **`kind` is the only discriminator.** A field is a discriminator when its value changes the
   schema of its siblings — which keys are allowed, which are required, what type they hold. Its
   variants are kinds. The test applies to any field, booleans included, and to keys of which
   exactly one may be present (the tag is implied by the key).
2. **A nested variant is a slot on an abstract.** The field is an `x-telo-ref` slot constrained to
   a `Telo.Abstract`; each variant is a kind that `extends` it, written inline at the use site or
   named and referenced when shared.
3. **A variant set is open.** The slot names the abstract, never its variants. The holder reads a
   variant only through what the abstract declares; what differs per variant is supplied by the
   variant through a seam the abstract declares. A module implementing a vocabulary may name that
   vocabulary's kinds (specific names generic); the slot's owner may not.
4. **One home per shared key.** A key every variant takes is declared on the abstract and
   inherited. A key only some take is declared by each variant taking it, typed from one named
   shape (`Telo.JsonSchema`). Inheritance is single and overlaps cross-cut, so no intermediate
   abstract is created for a partial overlap.
5. **Rules relate values, never keys.** `x-telo-resource-rules` constrains values against each
   other (a minimum not above a maximum); it never states which keys may be present.

## Distinguishing questions

1. Does the field's value change which sibling keys are allowed, required or typed?
2. Top-level resource, or the value of another resource's field?
3. Exclusive keys: different things, or different spellings of one value?
4. Is the key taken by every variant, or by some?
5. Who must act differently per variant: the slot's owner, or an implementer of the vocabulary?

## Consequences

- **Changes the sibling schema** → an abstract and a kind per variant; a `type:` / `mode:` /
  `variant:` field, or a boolean unlocking keys, is disqualified. **Same keys under every value**
  → a plain field; kinds differing only by a value a plain field could hold are disqualified.
- **Value of a field** → slot on the abstract. A field accepting several named shapes told apart
  by which keys are present is disqualified; so is one owner kind per nested variant.
- **Different things** → kinds under an abstract. **Different spellings of one value** → one field
  whose forms differ by their own shape (scalar or object, reference or literal). Sibling keys
  with "exactly one of" — as a rule or as schema branches — are disqualified.
- **Every variant** → the abstract. **Some** → each variant, one named shape. An intermediate
  abstract for a partial overlap is disqualified; so is one key carrying a different type or
  meaning across variants of one abstract.
- **Owner** → disqualified: a slot listing its variants' kinds, or an owner branching on the
  concrete kind it holds. **Implementer of the vocabulary** → may name the vocabulary's kinds; a
  variant from another module reaches it through the declared seam.

**Always:**
- A key described as "ignored when…" or "only used if…" proves a discriminator; apply principle 1.
- Establish from the codebase how per-variant behaviour is dispatched before deciding; never
  assume it.

## Horizon

A variant added by another module · a second implementer of the same vocabulary · a variant
gaining a key no other takes · the visual editor building a form from the schema alone · a second
owner wanting the same choice · 10× the variants · one variant needing its own contract,
controller or deprecation.

## Verify

1. No field's value changes which sibling keys are allowed, required or typed; no key is described
   as ignored or conditional.
2. A key foreign to a variant is refused by that variant's own schema, with no
   `x-telo-resource-rules` entry involved.
3. No `x-telo-resource-rules` rule states which keys may be present.
4. Every slot holding a variant names the abstract; its owner names no kind extending it.
5. A variant declared in another module is accepted at the slot with no change to the owner or the
   abstract.
6. Every key common to all variants is declared once on the abstract and reads with a static type
   through it; a key shared by some has one named shape behind it.
7. No two kinds under one abstract differ only by a value a plain field could hold.
8. Given the schema alone, the editor shows exactly the keys of the chosen kind.
