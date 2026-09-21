# Starters for the Telo editor

## Problem

The editor's first-run UX is a bare "Open workspace" panel, and "New application/library"
scaffolds an empty two-line manifest (`kind` + `metadata` only). A newcomer has no working
example to start from and no on-ramp to the standard library. We want a curated gallery of
runnable starters surfaced both on first run and when creating a new module, so a user can
pick a name and a starter and immediately have a working app.

A starter is a working manifest the editor copies once into the user's workspace. It is not a
blueprint (an importable library exporting a templated application kind, under `blueprints/`),
and "template" in Telo means only the body of a templated definition.

## Solution

**Curated starter set, hosted remotely, opened by URL.** A top-level `starters/` directory
holds the curated set, split by category: app starters under `starters/apps/<id>/` and library
starters under `starters/libs/<id>/`. Each starter is a self-contained folder (`telo.yaml` plus
any assets listed explicitly under `files:`, never globbed, so the remote fetcher can enumerate
them). A `starters.json` index at the root of `starters/` lists every starter as
`{ "starters": [ … ] }`, each entry with `id, title, description, category` (`app` |
`library`) and `path` (e.g. `apps/http-api/telo.yaml`). This directory is deployed as static
assets and is the unit that later moves to its own repo — the editor never bundles the
manifests, it fetches them.

**Catalog.** The editor's catalog fetcher reads `starters.json` from a configurable
`startersBaseUrl` setting (default
`https://raw.githubusercontent.com/telorun/telo/refs/heads/main/starters`) when the gallery
opens. If the fetch fails the gallery shows an error with retry; "Start blank" is always
available so onboarding never hard-depends on the network. A setting persisted under the
earlier field name `templatesBaseUrl` is read as `startersBaseUrl` on load.

**Gallery + create flow.** One shared gallery component, filtered by category. The user
picks a name, then a starter (or blank), and it materializes. Under the hood the only
variation is the destination adapter, chosen automatically:

- **Sidebar "New application/library"** (a workspace is open) — writes into the current
  workspace at `apps/<name>/` or `libs/<name>/` via the active adapter, then reloads the
  workspace (preserving open tabs) and opens the new module. The shared dialog carries the
  starter pick (app starters for the Applications section, library starters for the
  Libraries section).
- **Onboarding** (first run, no workspace) — writes into the localStorage virtual workspace,
  the path `?open` already uses, so it works with no directory picked (including in the
  browser). The empty-workspace panel offers "Start from a starter", which opens the same
  dialog filtered to app starters.

Both paths are one operation that branches on whether a workspace is open to pick the
adapter/root, then delegates the domain work (slug → existence probe → build files → write)
and commits the resulting workspace to editor state. The full file set is built **before**
any existing directory is deleted, so a starter-fetch failure can never destroy the target.
Starter fetching reuses the remote-open pipeline **unchanged** (root + same-origin relative
imports + listed `files:` assets), then strips the plan's paths down to the starter folder and
rewrites the root `metadata.name` to the picked name.

**Confirmation.** Materialization is direct — no import preview. The only prompt is the
existing overwrite confirmation, shown when the target `apps/<name>/` (or `libs/<name>/`)
already exists.

## Decisions

- **Starters fetched by URL, not bundled** — the curated set is the seed of a future
  standalone repo; the editor holds only a base-URL setting (with a default constant), so a
  user can repoint it at runtime and only changing the shipped default needs a rebuild.
  Bundling the manifests into the editor build would couple every starter edit to an editor
  release.
- **Remote `starters.json` index** — the starters repo owns its own list; adding a starter
  needs no editor change. An offline first run shows an empty gallery, and "Start blank"
  always remains.
- **Destination chosen by context, not by the user** — the user's model is "pick a name, pick
  a starter, done." Sidebar create lands in the open workspace; onboarding lands in the
  virtual workspace.
- **Reuse the remote-open pipeline** — starters are opened through the same fetch-and-write
  mechanism as `?open`, generalized over the destination adapter. Multi-file starters work
  because that pipeline already follows relative imports and listed `files:` assets.
- **Direct materialization, overwrite-only confirmation** — starters are curated and trusted,
  so the import-preview step is skipped; the sole guard is the name-collision overwrite prompt.
- **Explicit `files:` in starters** — assets are listed literally, never globbed, because the
  remote fetcher cannot enumerate a glob over a raw URL.
- **Starter set** — the catalog in `starters/starters.json` is the list. App starters cover the
  common on-ramps (console I/O, HTTP API, REST + SQLite todo, AI agent console, scheduled job,
  webhook receiver, MCP server); library starters (reusable HTTP API, domain repository, custom
  kinds) are a separate category because their create flow and shape differ.
- **Every starter is tested** — each starter's own `tests/` directory runs through
  `starters/test-suite.yaml`, which CI invokes separately from the module suite.

## Example

A first-run user sees "Open folder…" and "Start from a starter." They pick **HTTP API**,
type the name `Weather`, and confirm. The editor fetches
`<startersBaseUrl>/apps/http-api/telo.yaml`, rewrites `metadata.name` to `Weather`, writes it
into the virtual workspace, and opens it — a working typed `GET` route they can run
immediately.

Later, inside an open workspace, they click **+ New application → Todo app**, name it
`Tasks`. The editor writes `apps/tasks/telo.yaml` plus the starter's `index.html` (listed
under `files:`) into their workspace and opens the new module.
