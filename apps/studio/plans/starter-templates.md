# Starter templates for the Telo editor

## Problem

The editor's first-run UX is a bare "Open workspace" panel, and "New application/library"
scaffolds an empty two-line manifest (`kind` + `metadata` only). A newcomer has no working
example to start from and no on-ramp to the standard library. We want a curated gallery of
runnable starter templates surfaced both on first run and when creating a new module, so a
user can pick a name and a template and immediately have a working app.

## Solution

**Curated template set, hosted remotely, opened by URL.** A new top-level `templates/`
directory holds the curated set, split by category: app templates under `templates/apps/<id>/`
and library templates under `templates/libs/<id>/`. Each template is a self-contained folder
(`telo.yaml` plus any assets listed explicitly under `files:`, never globbed, so the remote
fetcher can enumerate them). A `templates.json` index at the root of `templates/` lists every
template with `id, title, description, category` (`app` | `library`) and `path` (e.g.
`apps/http-api/telo.yaml`). This directory is deployed as static assets and is the unit that
later moves to its own repo — the editor never bundles the manifests, it fetches them.

**Catalog.** A new editor catalog fetcher reads `templates.json` from a configurable
`templatesBaseUrl` setting (default points at the hosted templates origin) when the gallery
opens. If the fetch fails the gallery shows an error with retry; "Start blank" is always
available so onboarding never hard-depends on the network.

**Gallery + create flow.** One shared gallery component, filtered by category. The user
picks a name, then a template (or blank), and it materializes. Under the hood the only
variation is the destination adapter, chosen automatically:

- **Sidebar "New application/library"** (a workspace is open) — writes into the current
  workspace at `apps/<name>/` or `libs/<name>/` via the active adapter, then reloads the
  workspace (preserving open tabs) and opens the new module. `WorkspaceTree.tsx`/`Sidebar.tsx`
  replace the inline name input with a shared dialog carrying the template pick (app templates
  for the Applications section, library templates for the Libraries section).
- **Onboarding** (first run, no workspace) — writes into the localStorage virtual workspace,
  the path `?open` already uses, so it works with no directory picked (including in the
  browser). `AppLifecyclePanel.tsx` gains a "Start from a template" entry that opens the same
  dialog filtered to app templates.

Both paths are one method — `createNewModule(kind, name, selection)` in
`hooks/useWorkspaceLifecycle.ts` — that branches on whether a workspace is open to pick the
adapter/root, then delegates the domain work to `materializeModule` in `loader/crud.ts`
(slug → existence probe → build files → write) and commits the resulting workspace to editor
state. `materializeModule` builds the full file set **before** deleting any existing directory,
so a template-fetch failure can never destroy the target. Template fetching lives in
`loader/templates.ts`: it reuses `loader/remote.ts`'s `buildRemoteImportPlan` **unchanged**
(root + same-origin relative imports + listed `files:` assets), then strips the plan's paths
down to the template folder and rewrites the root `metadata.name` to the picked name — so
`remote.ts` never had to grow a destination parameter.

**Confirmation.** Materialization is direct — no import preview. The only prompt is the
existing overwrite confirmation, shown when the target `apps/<name>/` (or `libs/<name>/`)
already exists.

## Decisions

- **Templates fetched by URL, not bundled** — the curated set is the seed of a future
  standalone repo; the editor holds only a base-URL setting (with a default constant), so a
  user can repoint it at runtime and only changing the shipped default needs a rebuild.
  Rejected bundling the manifests into the editor build (would couple every template edit to
  an editor release).
- **Remote `templates.json` index** (vs. a bundled descriptor list) — the templates repo owns
  its own list; adding a template needs no editor change. Accepted the offline-first-run cost
  (empty gallery) because "Start blank" always remains.
- **Destination chosen by context, not by the user** — the user's model is "pick a name, pick
  a template, done." Sidebar create lands in the open workspace; onboarding lands in the
  virtual workspace. Rejected always swapping into the virtual workspace (lossy/surprising
  when a real workspace is open) and rejected forcing a directory pick during onboarding
  (unnecessary friction, breaks browser use).
- **Reuse the remote-open pipeline** — templates are opened through the same fetch-and-write
  mechanism as `?open`, generalized over the destination adapter, rather than a second code
  path. Multi-file templates work because that pipeline already follows relative imports and
  listed `files:` assets.
- **Direct materialization, overwrite-only confirmation** — templates are curated and trusted,
  so the import-preview step is skipped; the sole guard is the name-collision overwrite prompt.
- **Explicit `files:` in templates** — assets are listed literally, never globbed, because the
  remote fetcher cannot enumerate a glob over a raw URL.
- **Template set** — App: Console I/O (read input → print output), HTTP API (typed GET route),
  REST + SQLite todo (multi-file: API + `Http.Static` frontend), AI agent console. Library:
  reusable HTTP API library (exports an `Http.Api` mount), domain CRUD library (exports a
  `SqlRepository`-backed resource). App templates cover the common on-ramps; libraries are a
  separate category because their create flow and shape differ.

## Example after the change

A first-run user sees "Open workspace" and "Start from a template." They pick **HTTP API**,
type the name `weather`, and confirm. The editor fetches
`<templatesBaseUrl>/apps/http-api/telo.yaml`, rewrites `metadata.name` to `weather`, writes it into
the virtual workspace, and opens it — a working typed `GET` route they can run immediately.

Later, inside an open workspace, they click **+ New application → REST + SQLite todo**, name it
`tasks`. The editor writes `apps/tasks/telo.yaml` plus the template's `index.html` (listed under
`files:`) into their workspace and opens the new module.
