---
"@telorun/templating": minor
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

Embed a file that ships beside the manifest, with `!include-text` and `!include-bytes`.

A brand font, a background SVG, a `.sql` file, a system prompt — each is a file
next to `telo.yaml`, and until now there was no way to make one a manifest
value. `Fs.File` reads at *invocation* time, resolves against the process cwd
rather than the module, and cannot supply a field read at construction; pasting
base64 into a scalar is unreviewable and contradicts the rule `x-telo-binary`
exists to enforce — that bytes always arrive by reference and are never authored
inline.

```yaml
kind: PdfMake.Document
fonts:
  Brand:
    normal: !include-bytes assets/Brand-Regular.ttf
background:
  svg: !include-text assets/page-background.svg
```

- **Paths are module-root-relative**, never relative to the file the tag was
  written in. That is the rule a controller's `path=` qualifier and
  `files:`/`assets:` patterns already follow, and it is what makes a path mean
  the same thing after publish, which inlines every `include:` partial into a
  single published `telo.yaml` — a per-file-relative path would silently move,
  passing `telo check` locally and failing only for consumers.
- **Confinement is decided from the written path alone** (`INCLUDE_PATH_INVALID`,
  `INCLUDE_PATH_ESCAPES_MODULE`), so the browser-side analyzer enforces it
  without a filesystem. The kernel re-checks rather than trusting that
  `telo check` ran. A computed path is deliberately not expressible: a file that
  ships inside the artifact has a name known at publish time, so the dynamic
  case belongs to `Fs.File`.
- **The read happens when the resource holding it is created**, not at manifest
  load — `telo.yaml` is its own artifact layer precisely so reading a manifest
  cannot pull the payload, and an app loads every imported library's manifest.
  A `with:`-scoped resource pays only when its scope runs. An embed on a doc
  that is never instantiated is therefore read by nothing, and reported
  (`INCLUDE_OUTSIDE_RESOURCE`) rather than silently ignored.
- **Publish adds a named file to the artifact automatically** — nothing is
  restated in `files:`.

Payload membership is now one generic mechanism rather than two derivations that
happened to agree:

- `TemplatingEngine` gains an optional `fileClaims(source)` hook, so an engine
  declares what its tag embeds. The `ref-slot.ts` precedent: one accessor on the
  contract, no consumer pattern-matching a shape.
- `collectModuleFileClaims` (`@telorun/analyzer`, browser-safe) is the single
  reader — engine claims plus the controller `path=`/`siblings=` claims, each
  carrying its path, layer role and selector. Deliberately **not** part of
  `analyze()`, whose pass is flattened and import-inclusive: its claims would
  mix in imported libraries' files and would make packaging depend on resolving
  the whole import graph.
- **Breaking:** `partitionLayers` takes that claim set instead of manifest text,
  and `unmatchedSiblings` entries carry `origin` (was `purl`). `readControllerClaims`
  moves out of the CLI. Publish now recognises neither a PURL nor a YAML tag, and
  refuses to publish when a named file does not exist.

**Fixed: an imported library measured module-relative files from the CONSUMER's
directory.** An import's child `ModuleContext` carried the importing manifest's
URL rather than the library's own, and `source` is what every module-relative
reference resolves against. So a library reading its own asset looked in the
app's directory — and if the app happened to have a file at the same relative
path, it silently got the app's. This was never specific to embeds: it is the
same `source` `ctx.resolveModuleFile` reads, so `Http.Static`, `mcp-client`,
`assert`'s manifest loader and `Test.Suite` were mis-resolving for an imported
library too, and one fix covers all of them. It also contradicted packaging,
which is per-module and had already placed the library's file in the library's
own artifact.

**Fixed: a file embed's type is now checked statically.** `substituteCelFields`
collapsed every tagged sentinel to a slot-shaped placeholder — right for `!cel`,
whose type is only derivable from the expression, wrong for these two, whose
result type is a constant of the tag. So `!include-bytes` at a `type: string`
slot passed `telo check` and failed at resource creation, and the reverse did
too. The substitution now uses the real type, and AJV plus the existing
`x-telo-binary` keyword reject both directions with no new diagnostic code.

Two latent bugs surfaced and are fixed, both from config-resident values that
previously could not exist:

- The CEL expansion walker rebuilt **any** object from its entries, so a byte
  buffer in a config field would have reached the controller as `{"0":137,…}`
  with nothing raising. It now recurses only into plain containers, the rule
  `precompileDoc` already followed.
- The same rule fixes a stack overflow: a template kind expands
  `${{ self.connection }}` to a live `ResourceInstance`, whose object graph is
  cyclic.

The Rust half mirrors the tag set and the path grammar, and resolves
`!include-text` at resource creation. `!include-bytes` fails there with an
explicit message: that kernel carries a manifest as JSON, which has no value for
raw bytes.
