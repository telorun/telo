---
"@telorun/analyzer": minor
"@telorun/templating": minor
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/http-server": minor
---

One value-type annotation: `x-telo-type` says what a value IS, and the
vocabulary is data both runtimes read.

Three annotations answered one question — *what is the value at this slot, beyond
what JSON Schema's `type` vocabulary can say?* — and each answered it
differently: `x-telo-type: TcpPort` (a nominal brand from a closed kernel table),
`x-telo-binary: true` (raw bytes, the one annotation that emitted validation
code), `x-telo-stream: true` (a live handle, exempt from schema walks). They
differ in *posture* toward the JSON Schema layer — refine, replace, exempt — not
in kind, so a fourth cost eleven files across four packages, and three defects
followed from the spread: an unrecognized brand degraded silently, a byte slot's
expression typed as `dyn` because nothing consulted `x-telo-binary`, and a module
string-matched the keyword because a module may import `@telorun/sdk` and there
was nothing there to read.

- **The vocabulary is DATA; the binding to a language is not.** A type is one
  JSON file under `sdk/value-types/`, copied into the SDK by its `prepare` and
  embedded by Rust with `include_str!` — the `analyzer/migrations/` arrangement,
  for the same reason. An entry declares `name`, `representation` (`json` + a
  `base`, or `instance` + a symbolic `binding`), `live`, `parameters` and a
  `description`, and nothing about any runtime. Each runtime carries its own
  table mapping `binding` to its own identity; a binding with **no row is a hard
  startup error**, never a skipped assertion, because a type that cannot be
  asserted would silently exempt every slot declaring it.
- **`registerTeloKeywords`** replaces five drifted AJV registration sites — the
  analyzer's `createAjv` and the kernel's `schema-validator`, `resource-context`,
  `observed-state` and `manifest-schemas`, which registered overlapping lists of
  twelve, four, one and one. Drift there is not cosmetic: a keyword that emits
  code was simply missing from any instance that forgot it, so one schema
  validated two ways depending on which AJV saw it.
- **Exemption is a property of the TYPE, not of a position.** The old walk
  neutralized only a key it found in a `properties` map, so an array-of-streams
  element was reached and left constrained even though it descended into `items`.
  Reading liveness off the declared type makes an item, a union branch and a
  property one case. It is exemption from **validation**, never from **typing**:
  a live type's arguments still travel through every schema-typing walk.
- **Value types are generic.** An entry declares named type parameters and the
  annotation's object form supplies arguments — `{ name: Telo.Stream, of:
  Telo.Bytes }`. An argument is a schema node, so it nests with no new grammar,
  and a bare name is sugar for a node carrying only the annotation, normalized in
  the single reader. Comparison is **covariant and gradual**: an omitted argument
  is *any* in both directions, so every producer and consumer that has not
  declared an element keeps checking exactly as it did. A definite conflict is
  `CEL_TYPE_ARGUMENT_MISMATCH`, reported where a produced value's schema meets a
  consuming slot's — a step's `inputs:` against the invoked target's contract,
  which is the one place both halves are in hand.
- **A shape is named with `!ref`**, Telo's one reference grammar, and `use:
  schema` has been in the `x-telo-ref` vocabulary for exactly this relation all
  along. The loader normalizes it to the canonical `telo:<module>/<Type>` `$ref`
  — authoring surface and internal form, the split `resolveRefSentinels` and
  `resolveSchemaRefKinds` already have. Normalizing rather than inlining is what
  preserves schema identity (the compiled-validator cache is keyed on it) and
  leaves a recursive shape expressible; carrying the owning module is what makes
  resolution alias-aware, where matching a bare `metadata.name` across a
  flattened list silently dropped the alias.
- **A tag's produced type is declared by its ENGINE.** `TemplatingEngine` gains
  `producedType()`; `!include-bytes` declares `Telo.Bytes` and `!include-text`
  declares `type: string`, and `substituteCelFields` loses its tag-name branch —
  the only place a tag's produced type was written down, written in the consumer.
- **`X_TELO_TYPE_UNKNOWN`** (Levenshtein-suggested) and
  **`X_TELO_TYPE_ARGUMENT_UNKNOWN`** replace the silent degrade, on every
  schema-bearing field of every manifest — not only definition docs, since an
  inline `inputType:` on an ordinary resource carries a schema too.
- **The migration selector gains a schema region.** `inSchema: true` bounds a
  rule to the kernel's own schema-valued keys, and only with it may `inKind` /
  `under` be `["*"]`, and only for a rule keyed on an `x-telo-*` annotation. That
  pairing is the containment: an annotation keyword occurs in author-written
  schema fragments inside ordinary resource documents, and that set of kinds is
  open, so enumerating it would be both incomplete and a violation of the
  topology-driven constraint.

**Breaking:** `x-telo-binary` and `x-telo-stream` are rewritten to `x-telo-type`
at load by the `normalize-value-types` migration, so every published manifest
keeps working and `telo migrate` repairs a file in place. `binaryKeyword` /
`isBinarySlot` / `X_TELO_BINARY` are removed from `@telorun/analyzer` in favour
of `registerTeloKeywords` and the SDK accessors; `withStreamPropertiesSkipped` is
now `withLiveValuesSkipped`. Value brands are `Telo.`-qualified (`TcpPort` →
`Telo.TcpPort`), which the same migration rewrites.
