# Telo for VS Code

Language support for [Telo](https://telo.run) manifests — diagnostics, completions, hover docs, go-to-definition, rename and import upgrades, all computed from the same static analyzer the `telo check` CLI uses.

Telo is a declarative runtime for backend applications: YAML manifests describe desired state, and the kernel resolves the dependency graph and runs a controller for each resource kind. Because manifests are statically analyzable, most mistakes are catchable before anything runs — this extension is where you see them.

## Features

### Diagnostics

Errors appear as you type, not at runtime. The analyzer resolves imports, walks the resource graph, and type-checks every CEL expression:

- **Unknown kinds and unexported kinds** — referencing `Foo.Bar` when the imported library does not export `Bar`.
- **Broken references** — a `!ref` pointing at a resource that does not exist, or at one whose capability the slot does not accept.
- **CEL type errors** — `CEL_UNKNOWN_FIELD` for a misspelled property, `CEL_NULLABLE_ACCESS` for dereferencing a value that may be null, and `CEL_IN_NON_EVAL_FIELD` for an expression written where it would be read as a literal string.
- **Lifecycle errors** — reading observed state (`resources.x.status.y`) in a field that resolves before anything has run.

Diagnostics follow `include:` — editing a partial file re-analyzes every entry manifest that pulls it in.

### Completions

Context-aware, driven entirely by the resolved schemas — nothing about specific resource kinds is hardcoded:

- **Kinds** at a `kind:` slot, filtered to what the current file actually imports.
- **Property keys** for the kind you are inside, from its `Telo.Definition` schema.
- **Reference names** at `!ref` slots, filtered to resources whose capability the slot accepts.
- **Import sources** at `imports:` — searched against the [Telo hub](https://hub.telo.run), including version lists.

### Hover and go-to-definition

Hover a kind or a reference for its description and schema. Go-to-definition jumps to a resource's declaration, across module boundaries into imported libraries.

### Rename

<kbd>F2</kbd> on a resource instance, a `Run` step name, or a `variables:` / `secrets:` / `ports:` key renames it together with every reference — `!ref` targets, `targets:` entries and the identifier inside each CEL expression, across every file in the module. Only the identifier moves: renaming a step rewrites `steps.<name>` inside a `${{ … }}` interpolation without touching the rest of the string.

Renaming is a refactor rather than a repair, so it is not offered as a quick fix on a naming diagnostic — a fix rewrites one node, and a rename is only correct when every reference moves with it.

Some names are deliberately refused, with the reason shown in the rename box:

- An instance listed in `exports.resources`, or a library's `variables:` / `secrets:` key. These are the module's public surface — consumers reference them from files your workspace may not contain — so renaming one is a breaking change to version, not an edit to apply.
- A name declared twice in reach (a `with:`-scoped resource shadowing a module-level one, two steps in one resource sharing a spelling). References resolve to different declarations, and no edit set is right for both.
- A kind name, a module name or an import alias — not supported yet.

The new name is checked against the [naming rules](https://telo.run/learn/style-guide) before anything is written, so a rename cannot introduce a name `telo check` would reject.

### Import upgrades

CodeLenses over your `imports:` block show when a module has a newer version on the hub, or is missing its integrity pin:

- A summary lens on the `imports:` key — `2 imports outdated · Upgrade all`
- A per-entry lens — `↑ 0.9.0 → 1.0.0`
- A per-entry lens on an unpinned import already at the newest version — `+ pin 1.4.0`

Applying an upgrade rewrites the source ref and re-pins it to the new version's integrity hash, which the hub publishes alongside the version list. The pin is written in the shape you wrote — a `#sha256-…` fragment on the source, or the value of an `integrity:` key. Prereleases are excluded by default, and a moving tag (`latest`) or a digest is never pinned, both matching `telo upgrade`.

Where the hub has no pin for the target version, the upgrade still applies and the stale pin is removed — it hashes the `telo.yaml` of the version being replaced — with a notification saying so. Run `telo upgrade` to re-pin from the origin.

A lens only ever offers a version this Telo can run. Each candidate's own `telo.yaml` is read from the manifest cache (`telo.manifestCacheUrl`) and its declared [`requires.telo`](https://telo.run/extend/declaring-runtime-requirements) range checked, newest-first, so an upgrade stops at the newest hostable version instead of walking you into a manifest the load gate rejects. When a newer version was held back the lens says so (`↑ 0.9.0 → 1.0.0 ⚠`, with the reason in its tooltip); when nothing newer can run, the entry shows `⚠ … · update telo to upgrade` rather than silently reading as up to date. A candidate that cannot be read is never treated as incompatible — an unreachable cache must not freeze your imports.

Version lookups and compatibility answers are memoized so lens resolution stays off the keystroke path. Run **Telo: Check Imports for Updates** to drop the memo and re-check. Hub failures go to the `Telo` output channel.

### Syntax highlighting

`telo.yaml` and `*.telo.yaml` get a dedicated grammar plus semantic tokens, so `!ref` targets and `!cel` expressions are highlighted as references and code rather than plain strings.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `telo.importUpgrades.enabled` | `true` | Show upgrade CodeLenses over `imports:`. Disable to stop the editor contacting the hub entirely. |
| `telo.hubUrl` | `https://telo.sh` | Hub **API** host used for import-source autocomplete and version lists. This is the machine-facing endpoint — the browsable index lives at [hub.telo.run](https://hub.telo.run). |

## Network access

Analysis is local. The extension contacts the network in two cases only: resolving imports that are not on disk, and checking module versions for the upgrade lenses. Setting `telo.importUpgrades.enabled` to `false` stops the latter.

## Learn more

- [telo.run](https://telo.run) — documentation
- [hub.telo.run](https://hub.telo.run) — module hub
- [github.com/telorun/telo](https://github.com/telorun/telo) — source and issues

## License

Sustainable Use License (fair-code). See [LICENSE](https://github.com/telorun/telo/blob/main/LICENSE).

Developed by CodeNet Sp. z o.o.
