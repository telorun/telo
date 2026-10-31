# `telo format`

A formatter for Telo manifests: one engine behind a CLI command and editor format-on-save, so the flow-style rule is enforced by a tool instead of by memory.

## Before

Manifests are written in whatever style the author or an agent produced; a scalar list like an `enum` of 20 keywords takes 20+ lines. The style rule lives in `CLAUDE.md` and depends on whoever edits remembering it. No command formats or checks a manifest's layout, and VS Code does nothing on save.

## After

**The style.** Layout only — meaning never changes.

- A list whose items are all plain scalars is written in flow style, on one line however long: `enum: [as, break, const]`.
- A map is written in flow style when it has at most three entries and each value is a plain scalar, a scalar list, or itself such a map: `not: { enum: [...] }`. A single-key chain is the same case.
- A collection stays block style when anything inside it carries a tag (`!cel`, `!interpolate`, `!include-*`, `!ref`, …), holds a multi-line string, or has a comment inside it. Tagged values themselves are never rewritten.
- Every document's top level stays block style.
- Existing quoting is kept; a scalar YAML would otherwise read as another type (`"true"`, `"null"`) stays quoted.
- Comments, key order and blank lines between entries are kept.

**`telo format [<path>…]`.**

- Takes files, directories and globs; with no argument it uses the current directory. A directory is searched for manifests, skipping `node_modules`, `dist`, `.git`, `.telo` and `__fixtures__/`. A file named explicitly inside `__fixtures__/` is formatted.
- A file is a manifest when its first document has a dotted `kind` (`Telo.Application`, `Http.Server`); other YAML (workflows, lockfiles, Kubernetes manifests) is skipped when found by search, and a named non-manifest file is refused with a message saying why.
- Rewrites files in place and reports each file it changed on the `Output` seam, in both formats.
- `--check` writes nothing and exits 1 when any file would change, listing them.
- A file that does not parse is reported with its location and the run exits 2; the other files are still processed.
- There is no `--recursive`: files are selected by path, directory or glob, as prettier and `gofmt` do.

**Editor.** The language server answers document-formatting requests for a manifest with the same engine, so VS Code formats the file on save using the telo version the workspace selected. The extension turns format-on-save on by default for telo manifests. A document that does not parse yields no edits and the existing diagnostics explain why.

**Placement.** The engine lives in the analyzer package (it already owns loading and migrations, runs in the browser, and uses only the `yaml` library it already depends on); the CLI owns file discovery and writing; the language server and its editor-support package own the request. The Rust CLI gets no `telo format` in this change.

**Housekeeping in the same change.**

- `CLAUDE.md`: the flow-style rule's last sentence becomes "run `telo format` on a manifest you edit", replacing the whole-file reformat instruction; the CLI and analyzer guides mention the command and the engine.
- The authoring-agent primer states the flow-style rule so generated manifests start out conforming.
- The CLI docs and `docs/guides/style-guide.md` describe `telo format` and the style.
- One changeset naming the telo version line packages and every other published package touched.

## Verify

- Formatting a second time changes nothing.
- The parsed data of every manifest under `modules/` and `examples/` (tags included) is identical before and after formatting; and a formatted sample of them still passes `telo check`.
- The 20-keyword `enum` example from the plan's discussion becomes one line, with `"false"`, `"null"` and `"true"` still quoted.
- A map with four entries, or any collection containing a `!cel`, a comment or a multi-line string, stays block style.
- `telo format --check` on a conforming file exits 0 and on a non-conforming one exits 1 without touching the file; a directory run skips `__fixtures__/` and non-manifest YAML; a named non-manifest file is refused.
- A syntactically broken file exits 2 naming the file and line while its neighbours are still formatted.
- In VS Code, saving a non-conforming manifest rewrites it; saving a broken one changes nothing.
