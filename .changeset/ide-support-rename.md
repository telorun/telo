---
"@telorun/ide-support": minor
---

Rename, as an editor operation: `prepareRename` resolves the symbol under the
cursor, `buildRename` returns the edit set for it across every file in the
module. The VS Code extension wires both to <kbd>F2</kbd>.

**A rename is a refactor, not a fix**, which is why it lives here rather than
behind a `DiagnosticFix`. A fix is a whole-value replacement for ONE node,
verified by the diagnostic that produced it; a rename is only correct when every
reference moves with it, so its unit is the reference graph. Rewriting
`metadata.name` alone leaves every `!ref`, `resources.<name>` and
`steps.<name>.result` pointing at a name that no longer exists — a rename offered
as a quick fix would break the file it claimed to repair.

Edits are precise sub-spans, not whole scalars. A `!ref` scalar's own AST range
is its value (the tag excluded), and a CEL identifier's span comes from
`CelNode.propertyRange` — which the analyzer's node model has carried since it
was written, commented "for a future rename". So renaming a step inside
`output: "Username: ${{ steps.readUsername.result.value }}, Password: ${{ … }}"`
rewrites that one identifier and leaves the rest of the string, including a
second interpolation, untouched.

Three renameable surfaces, chosen because their reference set is enumerable from
the workspace: a resource instance, a `Run` step name, and a `variables:` /
`secrets:` / `ports:` key. Everything else is an explicit refusal carrying its
reason, never an empty result — a refusal here usually means the name has too
many references, which is the opposite of what "nothing to rename" says:

- An instance in `exports.resources`, or a `Telo.Library`'s declared config key.
  These are the module's public surface, referenced from files the workspace may
  not contain and, for a published consumer, cannot. That is a breaking change to
  version, not an edit to apply, and a rename box that silently shipped one would
  be the worst available framing.
- A name declared twice in reach — a `with:`-scoped resource shadowing a
  module-level one, two steps in one resource sharing a spelling. References
  resolve to different declarations and no edit set is right for both.
- A kind name, a module name or an import alias: their references are
  alias-qualified halves of `kind:` / `extends:` / `x-telo-ref` / `exports.kinds`
  values, a materially larger surface that wants its own pass.

The new name is checked through the analyzer's own `checkName`, so a rename
cannot introduce a name `telo check` would then reject. A step's edit set is
document-scoped, because `steps.<name>.result` is readable only inside the
resource whose body declares the step and a resource is one YAML document — which
is also what makes two same-named steps in one document the ambiguity to refuse.
The live buffer always stands in for the current file's snapshot: the graph is
taken at the last analysis, so edits computed against it would otherwise write
stale offsets into a file the author has since changed.

`chainAt` / `flattenChain` / `celChildren` moved out of
`definition/resolve-cel-target.ts` into a shared `cel-chain.ts` rather than being
copied. The exhaustive `celChildren` switch is the reason: an unhandled `CelNode`
variant fails the build there, and a second copy would mean the failure is caught
for go-to-definition (a missed jump) but not for rename (a reference left
pointing at the old name).
