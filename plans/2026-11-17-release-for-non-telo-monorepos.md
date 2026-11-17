---
status: done
priority: medium
depends-on: []
packages: [release/nodejs, release/rust, cli/nodejs, docs]
refinement: not-started
issue: https://github.com/telorun/telo/issues/833
---

# `telo release` for monorepos that are not Telo modules

## Problem

`telo release` already plans units with no ecosystem (a declared `version:` and `payload:`), but five things stop it fitting a repository of deployable components such as `apps/*` (Node and Python services, containers with only a Dockerfile) whose pipeline is triggered by a git tag:

- **A unit with no ledger entry is never planned from edits.** After the first `apply`, a unit no fragment ever named has no entry in `.changes/ledger.yaml`. Editing its files reports "Nothing to release" while `CHANGELOG_ENTRY_REQUESTED` lists it as changed. The only way to give it a baseline is a throwaway fragment per unit; `adopt` serves changesets setups only.
- **The tag is fixed to `<unit key>@<version>`.** `apps/proxy@0.1.1` cannot feed a pipeline keyed on `proxy/0.1.1` or `v0.1.1`.
- **There is no Python ecosystem.** Each Python unit needs a hand-written `version: { file: pyproject.toml, pointer: /project/version }` plus a `payload`, and gets no edges from path dependencies. A Python worker depending by path on a Python library does not bump when the library does.
- **The docs and one diagnostic mislead.** There is no example of a plain-text version file or a TOML pointer; the generic edge rule (another unit's version file inside a unit's payload) is documented nowhere for users; and `WORKSPACE_UNIT_PAYLOAD_EMPTY` does not say that a private npm package is fixed by adding `payload:` beside `ecosystem: npm`.
- **A release PR or release notes need a hand-written renderer.** `status` and `apply` print text or JSON, so a pipeline that opens a release PR must turn the plan into markdown itself, and fit the host's body-size limit by itself. Telo's own pipeline does exactly that in a script, grouping units by this repository's path prefixes and cutting its output in stages.

## Constraints

None.

## Surface

**Added**
- `telo release baseline [--unit <key>…] [--dry-run]` — records the current state of every unit with no ledger entry, without bumping anything.
- `release.tagFormat` and the unit-entry key `tagFormat` — the tag template; the entry's value wins over the workspace's.
- Unit-entry key `name` — a short label for a unit, default the last segment of its key; used by `{name}` only.
- Tag placeholders `{key}`, `{name}`, `{version}`.
- `WORKSPACE_TAG_INVALID` — a template with no `{version}`, an unknown placeholder or stray brace, `{name}` on a unit with no name (the root unit), or a rendered tag git refuses.
- `WORKSPACE_TAG_COLLISION` — two units' templates can produce the same tag; names both units.
- Ecosystem `pypi` — `ecosystem: pypi`, with the optional `registry` setting (a simple-API index base URL, no default).
- Version-file handler for `pyproject.toml`, so `version: pyproject.toml` also works on a unit with no ecosystem.
- `-o markdown` — a third value of the existing `-o` / `--output` option, legal on `status`, `check` and `apply` only: the plan as a markdown document on stdout.
- `--max-length <n>` — with `-o markdown`, the most Unicode code points the document may hold.
- `tag` field on every unit in the JSON of `status`, `check` and `apply`, and on every `order` row — the rendered tag for that version.

**Changed**
- `telo release tag` renders each moved unit's effective template (candidates included); with no template set the tags are exactly today's, except that the root unit (key `.`) tags `v<version>`, since `.@1.0.0` is not a legal git ref.
- The `name` of a unit in plan JSON is the unit's `name` key when set, else the existing package-derived name. Text output keeps showing the key, which is what `--unit`, fragments and groups take.
- `WORKSPACE_UNIT_PAYLOAD_EMPTY` — names each anchor with the adapter's own reason ("npm at `.` is `private: true`", "pypi at `.` declares no `[build-system]`") and says to declare `payload:` on the same entry beside `ecosystem:` (its packages still supply version and edges), or exclude the unit with `'!<path>'`; the marker-time message gets the same example.
- `WORKSPACE_UNIT_VERSION_UNRESOLVED` — shows both spellings, `version: <file>` and `version: { file, pointer }`.
- Every other command refuses `-o markdown`, and `--max-length` without `-o markdown`, as a usage error (exit 2) naming the formats it can write.
- The changelog writer renders a multi-line fragment body with its continuation lines indented, so a list or code block stays inside its item; the release notes and `CHANGELOG.md` show identical bytes for every entry.
- The "Seeding it" adoption path in the release guide becomes `verify --write`, then `baseline`.

**Removed**
- Telo's own release-PR body renderer, which `-o markdown` replaces; its script keeps only the intro line and the host's budget.

## Solution

**Baseline.** `telo release baseline` is for adopting `telo release` in a repository that already has published things. By default it covers every resolved unit with no ledger entry; `--unit` (repeatable, as on `add`) narrows it. Per unit, at its current version, each layer whose ecosystem has registry read-back takes the registry's answer (as `verify` does); each layer with no read-back (docker, a declared payload, a `pypi` anchor with no `registry`) takes the working-copy digest the same evidence path `apply` records, plus the registry base it was built against. It writes only `.changes/ledger.yaml` — no version, changelog, fragment or tag. A unit that already has an entry is skipped and listed; naming one with `--unit` is an error pointing to `verify --write`, because an entry records a publish and overwriting it would hide unreleased drift. A read-back that says the version is not published leaves the unit without an entry and reports it; a unit carrying a candidate version is reported and not recorded. A second run records nothing and exits 0; `--dry-run` lists what would be recorded. `verify --write` keeps baselined digests for layers with no read-back.

**Tag template.** `release.tagFormat` sets the template for the workspace and any unit entry may set its own `tagFormat`, which wins (the cascade `ignore` and `maxBump` already use). The default is `{key}@{version}`; the root unit's is `v{version}`. `name` is a label and never an address: no uniqueness rule, nothing takes it besides `{name}`. The planner never reads a tag as the source of truth (the ledger is), so changing a template replans nothing and only shapes future tags. Every reader of a tag takes the rendered `tag` from the plan or `order` JSON instead of formatting it — including Telo's own publish scripts and the `blob/<tag>/…` links of a published package, which keep producing today's tags under the default.

Validation: a template without `{version}`, an unknown placeholder or a stray brace is caught when the marker is read; `{name}` reaching a unit with no name and a rendered tag that breaks git's ref rules are caught when units are resolved. Collisions are decided statically by intersecting two units' rendered patterns (text around a version), so `{name}{version}` over units named `a` and `a1` is refused before any tag exists.

**Markdown output and its limit.** `status`, `check` and `apply` print the plan as a markdown document with `-o markdown`, so a pipeline writes a PR body or release notes with no renderer of its own. It rides the one `-o` seam: a command whose result is not a plan refuses it as a usage error rather than falling back to text. The document goes to stdout only when the command succeeds; on exit 1 stdout is empty and diagnostics stay on stderr as in every format. CommonMark only, heading levels 2 and 3 (the host owns level 1 and any intro).
- *Shape.* Units that carry changelog entries come first, each a level-2 heading with its key and `<from> → <to>`, a line with the level and reasons (as the text output words them), then the release group when there is one and the planned `tag`, then the entries under level-3 kind headings in the changelog's order — Added, Changed, Deprecated, Removed, Fixed, Security — each body verbatim. Units with no entry follow in one closing section, "Units with no changelog entry". No grouping by path, ecosystem or configured section; an empty plan renders as the sentence the text output already uses.
- *Limit.* With `--max-length <n>` the document is the first of these stages that fits in `n` code points (trailing newline included), and with no option nothing is ever cut: (1) full; (2) the no-entry section as one paragraph of keys and new versions, reasons dropped; (3) as 2, plus every entry longer than a computed cap cut — the largest cap at which the document fits, never below 200 code points — flattened to single spaces, cut at the last space, ending in "…", with one note saying cut entries end in "…"; (4) every unit as one paragraph of keys and new versions, entries left out; (5) one sentence with the unit count and how many carry entries. A stage that would equal the previous one is skipped; each marker names only "the length limit" and what was left out, never a host or a PR. When even stage 5 does not fit, the command exits 1 with empty stdout, naming the shortest length this plan's document can take and the limit given.
- *In Telo's own pipeline* the script prepends its "merging publishes candidates / finals" line and passes the host's budget minus that line and the headroom the PR action appends; it keeps the pointer to the PR's diff.

**The `pypi` ecosystem.** Named for the registry and PURL type, like `npm` and `cargo`; `python` is a language and leaves no name for conda.
- *Recognition.* An anchor is a directory holding a `pyproject.toml` with a `[project]` table carrying `name`. A Poetry-1 file with only `[tool.poetry]` is not an anchor: that unit declares `version: { file: pyproject.toml, pointer: /tool/poetry/version }` and a payload.
- *Version.* `project.version`. A version the planner cannot plan is refused naming the value; `apply` writes the planner's spelling, and read-back looks the version up in PEP 440 normalized form (`1.0.0-rc.1` is served as `1.0.0rc1`). When `project.dynamic` lists `version`, the anchor keeps no static version and the unit must declare `version:` (a plain version file the build backend reads); a git-derived version (setuptools-scm, hatch-vcs) cannot be planned and the refusal says so.
- *Payload layer.* The member set of the sdist the declared `[build-system]` backend produces through PEP 517 `build_sdist` in an isolated environment, digested with the shared file-set digest; the backend's own include and exclude rules decide membership, so the adapter keeps no ignore list. A `pyproject.toml` with no `[build-system]` builds nothing: it contributes no layer, like a private npm package, and the unit declares `payload:` or anchors `docker`.
- *Registry.* With `registry` set, read-back fetches the sdist at the normalized version and digests its members by the same rule, a version the index does not serve reads as absent, and the destination is `<registry>/<normalized name>`. With none, the layer is unverifiable and keeps its recorded digest, and there is no destination.
- *Edges.* From runtime requirements only (`project.dependencies`, `project.optional-dependencies.*`) whose source is one of: `[tool.uv.sources]` with `path = "<relative dir>"` or `workspace = true` (resolved by the sibling's normalized `project.name`); `[tool.poetry.dependencies]` with `path = "<relative dir>"`; a PEP 508 `file:` reference rooted through `${PROJECT_ROOT}` (PDM) or `{root:uri}` (Hatch). Any other `file:` direct reference and any path leaving the workspace fails the plan, naming the requirement and the forms read. Never an edge: index, git and URL requirements (a pin), dependency groups and dev tables, and a path that is no unit's `pypi` anchor.
- *On apply.* A linked requirement with a single-clause `==`, `>=` or `~=` specifier is rewritten to the sibling's new version (other shapes are left); every lockfile that records a moved version or rewritten specifier (`uv.lock`, `poetry.lock`, `pdm.lock`) has that entry moved, as `Cargo.lock`'s is. Which lockfiles record a path member's version is confirmed against each tool when the adapter is written; the requirement is that every recorded one moves.
- The planner core gains one generic seam: a recognized package may report that it keeps no static version and why it contributes no layer, which is what the diagnostics print. The core still names no ecosystem. `telo-release` and `telo release` both register `pypi`, and the Rust twin gets both halves, running the same PEP 517 frontend subprocess.

**Linking units without an adapter.** No unit-entry key declares an edge (`dependsOn` is `WORKSPACE_UNKNOWN_KEY`). An edge is read from files so that it can be true: a stale hand-written one releases identical bytes and nothing can check it. A runtime version-range contract is a pin — the dependent is unaffected until its author edits the range, which moves its own digest. The guide says which of three mechanisms covers each case, one example each:
1. The dependent really consumes the other's files: its docker `context:` spans both, or its declared payload (the `{ command }` form reaches a sibling's file) holds the dependency's version file — the generic rule then adds the edge.
2. An adapter's import edges where a manifest declares the dependency (npm, cargo, pypi, a Telo module's imports).
3. The two must ship together: `release.groups`.

**Docs.** `docs/guides/workspaces.md` and both release READMEs gain the plain-text version file (`version: VERSION`, a file holding only the version line) and the TOML pointer (`version: { file: pyproject.toml, pointer: /tool/poetry/version }`, with its limits: a `[table]` header and a `key = "value"` line; dotted keys and inline tables are refused). `docs/extend/releasing-modules.md` gets Tags, the edge guidance above and the new adoption path; the release package guide's sentence on tag names is updated. `name` and `tagFormat` join the marker schema data so editors complete them. Fragments for the `release` unit (and `cli`, which mounts the command tree, where its files change). Both halves are held by new rows in `release/conformance/` for markers, tag rendering and collisions, version files, plans (pypi edges), digests, commands (`baseline`, `-o markdown`, `--max-length`) and the diagnostics' messages, identical in Node and Rust. The markdown renderer gets its own vector file whose rows pin the full document (entries only, no-entry units only, both; a group and a tag; a multi-line body with a sub-list and a fenced block; markdown-sensitive characters passed through), each stage at exactly its length and at one less, a cap above and below 200, a cut at a word boundary and with no space, an astral character at the cut, an entry exactly at the cap, and the refusal; command rows pin the refused formats (exit 2), an empty stdout on exit 1, and the stdout of `status -o markdown`. The changelog writer's multi-line indentation gets a row of its own.

## Decisions

- **No `dependsOn`** — rejected despite the issue asking for it: every real case is already a file edge, a pin or a group, and a declared edge cannot be checked for truth (Nx accepts them because a stale edge only costs build time there; here it costs a release of unchanged bytes).
- **`pypi`, not `python`/`pip`** — the ecosystem is the index, not the language or one installer.
- **Payload is the backend's sdist, not an ignore list** — the build backend is the authority on what ships; a hand-written list diverges.
- **Edges only from declarations that make a sibling's working copy the installed dependency** — a plain requirement installed from an index is a pin; reading PEP 621 names alone would invent edges.
- **`baseline` is a command, not `apply --baseline` or a `verify` flag** — a mode flag on `apply` switches it between writing versions and consuming fragments; `verify`'s output means "what the registry says", not the author's assertion. Named after Flyway's `baseline` and Alembic's `stamp`.
- **Baseline skips existing entries** — they record publishes; overwriting hides drift.
- **`tagFormat` also per unit; root default `v{version}`** — one workspace can mix conventions (modules `{key}@{version}`, apps `{name}/{version}`); `.@…` is not a legal ref.
- **`tagFormat`, not `tag`/`tagName`/`tagPattern`/`tagTemplate`** — `tag` already names the rendered value (the JSON field, the command, the `WORKSPACE_TAG_*` codes), so the key holding the template must not be the same noun; `tagName` names the result too, `tagPattern` suggests matching, and `tagFormat` is semantic-release's name for this exact setting. A marker that sets `tag:` is refused as an unknown key.
- **`-o markdown`, not `--markdown` or `--format`** — the document is one more encoding of the plan, so it rides the format enum the CLI already has; a command that cannot write it refuses instead of falling back to text.
- **A limit option, `--max-length`, counting code points, with no default** — code points are what a character-limited host counts and what JSON Schema's `maxLength` already means; UTF-16 units are a JavaScript artefact Rust would have to imitate; a default would bake one host's number into a generic tool. Used without `-o markdown` it is a usage error, not silently ignored.
- **Staged shrinking, and refusing when nothing fits** — each stage gives up what a reviewer needs least and says so; an oversized document would only become an opaque rejection by the host.
- **No grouping by path prefix** — the Packages/Modules/Apps split is one repository's layout; the generic split is "has changelog entries or not", which also keeps the few described changes on top when a thousand units are republished. Collapsing each entry to one line (as today's script does) is rejected: it corrupts bodies holding lists or code.
- **Default uses `{key}`, not the package name** — names are not unique here and carry `@` and `/`; the key is the one identity.
- **`name` has no uniqueness rule** — nothing addresses a unit by name; collisions are checked on the tags themselves.
- **The `WORKSPACE_UNIT_PAYLOAD_EMPTY` wording is not the issue's** — `payload:` is accepted on the same entry as `ecosystem:` (the private package keeps its version and edges); advising to drop the ecosystem would lose them, and the core may not name npm, so the adapter supplies the reason.

## Example after the change

A marker for the issue's repository:

`telo-workspace.yaml`: `release: { tagFormat: "{name}/{version}", units: [ { path: apps/web, ecosystem: npm, payload: ["**"] }, { path: apps/api, ecosystem: pypi }, { path: apps/worker, ecosystem: pypi }, { path: apps/proxy, version: VERSION, payload: ["**"] } ] }`

- `telo release baseline` records all four units; a later edit under `apps/proxy` plans an unattributed patch.
- `apps/worker` listing `api` under `[tool.uv.sources]` with `workspace = true` makes `status` show it bumping with `apps/api`.
- `telo release tag --dry-run` lists `web/1.4.0`, `api/1.2.1`, … — and the JSON rows carry the same strings.
