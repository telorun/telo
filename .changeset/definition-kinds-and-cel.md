---
"@telorun/ide-support": minor
"@telorun/analyzer": minor
---

Go to definition now covers kinds and CEL scope variables, not just `!ref`.

`buildDefinition` dispatches on what the cursor sits in rather than on the field
it happens to be under, so three symbol classes navigate:

- **Alias-qualified kinds** (`kind: Http.Server`, `extends:`, `x-telo-ref`) jump
  to the `Telo.Definition` / `Telo.Abstract` that registers the kind, following
  `exports.kinds` re-exports to the owning module the way the kernel resolves
  the kind at runtime. `Self.<Kind>` stays in the declaring module; a
  `Telo.<Kind>` built-in has no manifest and resolves to nothing.
- **CEL identifiers** — `variables` / `secrets` / `ports` jump to their block on
  the module doc and their member to that block's entry (`variables.port` →
  `variables:` then `port:`); `resources.<name>` and `resources.<Alias>.<name>`
  go through the same instance lookup a `!ref` uses. A chain nested inside a
  call or operand resolves too.
- The **alias half** of any qualified value — a kind's or a `!ref`'s — jumps to
  the `imports:` entry that declares it, so `Http` and `Server` in
  `kind: Http.Server` are separately navigable.

Signature and return shape are unchanged, so hosts pick this up without edits.

The export gate is resolved through the analyzer's own `resolveExportedKinds`
fixpoint and `parseExportEntry` rather than a local walk, so navigation cannot
disagree with `telo check` about what an import exposes: `exports.kinds: []`
gates everything while an absent block gates nothing, a kind re-exported from an
ungated module resolves straight to it, and `exports.resources` is strict — it
has no permissive default, so an instance the target does not export navigates
nowhere instead of pointing at wiring the kernel refuses to resolve.

`@telorun/analyzer` gains `CelParseError`, thrown by `CelSegment.ast()` when a
CEL body doesn't parse. A consumer that wants to be lenient about an expression
the author is still writing can now catch that specifically, rather than a bare
`catch` that would also hide a defect in the AST wrapper. The third-party
parser's own error type stays internal, exactly as its AST type does.
