# Plan — `!include-text` / `!include-bytes` manifest tags

## Problem

A manifest cannot embed the contents of a file that ships beside it. A branded report needs background artwork, a brand font and a logo; a prompt library needs prompt text; a query-heavy app wants its SQL in `.sql` files. Today there are two routes and both are wrong. `Fs.File` reads at *invocation* time, resolves against the process cwd rather than the module, requires a step, and cannot produce a value for a field that is read at load. Pasting base64 into the manifest is unreviewable and contradicts the rule `x-telo-binary` exists to enforce — that bytes always arrive by reference and are never authored inline.

Nothing tells `telo publish` that such a file belongs to the module either, so every asset has to be restated in `files:` — a second list that drifts from the one place the manifest already names the file.

There is a second, structural problem underneath that one. Publish already derives part of the payload by **re-parsing the manifest with a vocabulary hardcoded into the CLI**: `readControllerClaims` in `cli/nodejs/src/bundle/partition-layers.ts` knows that `pkg:telo` / `local` is the bundled PURL type, that `path=` names an entry point and that `siblings=` claims extra files. Teaching that same file to also scan for `!include-*` would give the CLI a second hardcoded vocabulary for reading a manifest, and every future tag that embeds a file would have to be added there by hand. The mechanism has to be generic or it is not worth building.

## Solution

Two new templating engines, `!include-text` (→ string) and `!include-bytes` (→ `Uint8Array`), added to the closed built-in set in `templating/nodejs/src/builtins.ts` so kernel, analyzer, editor and the VS Code extension all agree the tags exist. The comment there is normative: per-host à-la-carte registration would let a manifest validate in one host and crash in another.

**Paths are module-root-relative** — resolved against the directory holding `telo.yaml`, never against the file the tag was written in. Literal paths only: no URLs, no absolute paths, no globs, no expressions. This is the rule every other file reference in a manifest already follows (a controller's `path=` is the built file relative to `telo.yaml`; `files:` and `assets:` are root-relative patterns), and it is what keeps a tag meaning the same thing before and after publishing — `telo publish` deletes `include:` and inlines every partial as an extra document into the single published `telo.yaml`, so a declaring file simply ceases to exist in the artifact.

**Confinement is a pure string check** on that root-relative path — no traversal above the module root — so it is decidable statically, in the analyzer, without a filesystem.

**Browser safety** decides the rest of the mechanism. The analyzer cannot read anything, so the tag parses to a **sentinel**, the way `!ref` does. Statically the value is typed — string or bytes — without the file being opened, so `telo check` and the editor type-check the slot while leaving the content unresolved.

**The read happens when the owning resource is created**, in the Phase-5 config walk that already replaces `!ref` sentinels with instances — not during manifest load. The artifact spec requires that `telo.yaml` be its own layer because "reading a manifest would pull the whole artifact and selective fetch would be defeated at the first step" (§1); resolving at load would defeat it just as thoroughly, since loading an app loads every imported library's manifest and would fetch every library's assets layer whether or not anything used them. Resolving at creation bounds the cost to modules whose resources actually instantiate, and a `with:`-scoped resource pays only when its scope runs. Consequently **the tags are legal only inside resource declarations**, which is where every use case lives and what makes creation-time resolution total; a tag elsewhere is a diagnostic.

**Existence** is checked Node-side over a local source tree, at check and load — cheap, and it gives `telo check` the missing-file diagnostic. For a published module the file is present by construction (the claim below put it in the payload) and the layer's `integrity` digest covers corruption, so no directory listing is needed and no layer is materialized to check.

### File claims: one seam, no tag-aware consumers

Payload membership becomes a single generic mechanism, and the tags are one producer feeding it.

1. **An engine declares its own file claims.** The `TemplatingEngine` contract gains an optional hook: given a tagged node's source, report the module-relative paths that node embeds. The two `include` engines implement it; `cel`, `ref`, `literal` and `sql` do not. This is the `ref-slot.ts` / `zone-slot.ts` precedent — one accessor on the contract, and no consumer pattern-matches the shape. A future tag that embeds files is then a one-file change. Because paths are root-relative, the hook returns them verbatim; it needs no knowledge of which file the node came from.

2. **A standalone, browser-safe helper aggregates claims for one module** from its parsed documents — engine claims plus the controller `path=` / `siblings=` claims — each entry carrying its path, the layer role it belongs to, and a selector where the role has one. It lives in the analyzer package so the editor and publish share one implementation, but it is **not** hung off `analyze()`: that pass runs over a flattened, import-inclusive manifest set, so its claims would mix in imported libraries' files, whose paths are relative to *their* module and must never join this artifact — and it would turn packaging, today derivable offline from manifest text, into a product of resolving the whole import graph. Per-module by construction, and root-relative paths make the answer identical whether it runs before or after publish inlines the partials.

3. **Publish consumes the claim set.** `partitionLayers` takes claims instead of manifest text, maps role to layer, and knows about neither PURLs nor tag names; `readControllerClaims` moves into the helper. Its documented "pure string work, testable without a filesystem" property survives — improves, in fact, since the YAML re-parse disappears.

So an `!include-*` path joins the payload for the same reason a controller's `path=` does, through the same code, with nothing restated in `files:`. The editor gets the same list for free, which makes a file picker for an `include` slot generic rather than tag-aware. Reads go through `ModuleArtifact`, so a published module's assets layer materializes on first genuine use.

**Bounds**: a 32 MB cap per file, with an error pointing at `Fs.File` for anything larger. A resolved value is held for the life of the resource; a streaming payload is a different primitive.

**Rust half**: `templating/rust` gains the same two tags. The tag set is part of what a manifest *means*, so the two loaders must agree even though the Rust kernel is otherwise narrow.

Touches `templating/nodejs` and `templating/rust` (the engines and the claims hook), `analyzer/nodejs` (sentinel typing, static confinement, the claims helper, the migrated controller-claim reader), `kernel/nodejs` (creation-time resolution in the Phase-5 walk, artifact reads) and `cli/nodejs` (publish partitioning, existence checks). Ships with a changeset for each published package, docs under `docs/`, and — mandatory, because this changes the authoring surface — a matching update to the authoring agent's system prompt in `apps/authoring-agent/chat/telo.yaml`, plus a CLAUDE.md sync.

## Decisions

- **Two tags named for their result type, not one tag that infers it.** A templating engine's `analyze` receives the expression and its environment, not the target slot's schema, so a single `!include` could not decide bytes-vs-text statically without new plumbing. Rejected: `!file` resolving against the slot's `x-telo-binary` annotation.
- **`include-`, not `read-` or a bare type name.** "Include" names compile-time embedding and distinguishes it from `Fs.File`'s runtime read; a bare `!bytes` reads as a cast. Kebab matches `x-telo-*`; the parser accepts it (verified alongside `_` and camelCase, so this is style, not capability).
- **Module-root-relative, not relative to the declaring file.** Publish inlines partials into one document, so a per-file-relative path silently changes meaning at publish — passing `telo check` locally and failing only for consumers, the worst available failure mode. Rejected: having publish rewrite each tag's path while inlining, which would put tag knowledge back into the CLI we just took it out of, and make the published manifest differ from its source in a way no author can see.
- **Payload membership is a declared claim, not a tag scan.** Publish must never name a tag, and the seam that prevents it also retires the PURL knowledge the CLI hardcodes today. Rejected: an `!include-*` scanner in `partition-layers.ts`, which would make the second special case look normal and the third inevitable.
- **The claims helper is standalone, not part of `analyze()`.** Packaging one module must not depend on resolving that module's import graph, and an import-inclusive result cannot answer a per-module question without being filtered back down.
- **Resolution at resource creation, not at manifest load.** Rejected: deferring to field expansion, which sounds lazier but leaves any field with no `x-telo-eval` annotation unexpanded — the controller would receive an unresolved value. The Phase-5 walk covers all resource config regardless of eval mode, which is what makes creation-time resolution total.
- **Publish infers inclusion instead of trusting `files:`.** The manifest already names the file; `files:` keeps its role for what the manifest cannot otherwise see.
- **Rejected: a computed path** (stacking two tags on one node is invalid YAML, but a nested `path:` carrying `!cel` parses, so this was a design choice, not a syntax limit). A file that must ship inside the artifact has a name known at publish time by definition, so the dynamic case and the artifact case are disjoint. A CEL path would make the claim unknowable at publish — the asset silently missing at runtime, only for untested values — degrade confinement from a static string check to a runtime path-traversal check, and remove the existence check from `telo check`. The needs behind it are served by including a closed set and selecting with CEL (the set genuinely is closed, since the artifact must contain every file it might use), or by `Fs.File` when the file is not a module asset. If hand-listing ever becomes tedious, the future-compatible shape is an `!include-dir` yielding a name→contents map, which keeps every static property; deliberately out of scope.
- **Rejected: a `Telo.Provider` kind that reads files at init.** It resolves against cwd rather than the module, cannot supply a field outside an eval region, and produces no claim for publish.

## Example after the change

```yaml
kind: PdfMake.Document
metadata: { name: CustomerReport }
fonts:
  Brand:
    normal: !include-bytes assets/Brand-Regular.ttf
    bold: !include-bytes assets/Brand-Bold.ttf
background:
  svg: !include-text assets/page-background.svg
```

The paths are relative to the module root, so they read identically whether this document lives in `telo.yaml` or in a partial under `documents/`, and whether it is read from a checkout or from a published artifact. Both files join the module's payload because the manifest names them, through the same claim mechanism that puts a controller's entry point there; neither appears in `files:`.
