# Telo Studio

Desktop manifest editor for [Telo](https://github.com/telorun/telo). Opens a
workspace directory, parses its YAML manifests, checks them against the telo
version each module is edited against, and provides Graph, Outline, Run, and
Source views for editing resources.

Built as a React + Vite SPA wrapped in a [Tauri](https://tauri.app) shell.

## Running applications

The desktop build ships the `telo` CLI beside itself and runs each Application
as a local `telo run` process, so a run needs nothing installed and no Docker.
Runs against a Docker or Kubernetes runner are still a runner away — pick one in
Settings; Docker is the one to use when a run should behave the way production
does (an image, a container, published ports), and it is the only local option
in the browser build.

Which `telo` runs is the runner's one setting. It defaults to the bundled
executable, which is the version this editor was built against; a path there
overrides it. Nothing is looked up on `PATH`.

## Editing against a telo version

Every diagnostic studio shows — in the source view, on form fields, on graph
nodes and in the outline — and the source view's completion, hover,
go-to-definition, rename, quick fixes and import-upgrade lenses come from the
engine of one telo version: the `@telorun/language-server` published with that
telo, running in a Web Worker. What studio reports is what that version's
`telo check` reports.

The top bar shows which version the active module is edited against —
**Telo 0.102.0**, with **(pinned)** when the workspace pins it and **(unreleased
build)** when studio was built before that release (a deployment of the main
branch ships such an engine) — and hovering it says what chose it. Beside it, the workspace's telo version setting:

- **Auto** (the default) chooses per module from the `requires: telo:` ranges of
  the module and its imports, exactly as the VS Code extension does (see
  [Editing against a telo version](../../docs/guides/editor-telo-version.md)).
- **An exact version** pins every module of the workspace to it.

The list shows every available version newest first, marked as bundled, cached
or not, and accepted or refused by the active module's ranges. Studio ships one
engine; other versions are downloaded from the npm registry
(`registry.npmjs.org`), verified against their published `sha512` integrity and
kept in the browser's Cache Storage (`telo-engines`). When the chosen version
cannot run — offline and not cached, a pin studio does not offer, an engine that
failed verification, crashed or never started — or no available version satisfies the module's ranges,
the top bar says so with **Select version** and **Retry**; no other version is
used instead.

The setting is per workspace and affects editing only: **Run** uses the runner's
own `telo`, whatever version the editor checks against.

## Development

Run the Vite dev server on its own (browser-only, no native shell):

```bash
pnpm dev
```

Run the full Tauri desktop shell against the dev server:

```bash
pnpm tauri dev
```

A desktop build carries a `telo` sidecar, staged by `pnpm stage:cli` (pass
`--triple` to stage for another target). The dev and build hooks run it when
nothing is staged yet, so the **first** `tauri dev` in a fresh checkout builds
the ~100 MB single-file binary before the dev server starts; later runs reuse
it, and `pnpm stage:cli` rebuilds it after CLI changes — the hook reports what
is staged rather than deciding it is current. A shell started with no sidecar
beside it (`cargo run`) falls back to this checkout's CLI.

## Building

```bash
pnpm build          # Vite build → dist/
pnpm stage:cli      # Build the telo sidecar for this machine
pnpm tauri build    # Native desktop bundle
```

## Testing

```bash
pnpm test           # Vitest, one-shot
pnpm test:watch     # Vitest, watch mode
```

## Layout

- `src/` — React app (editor UI, workspace model, analysis adapter, run adapters)
- `src-tauri/` — Tauri Rust host (native shell, Docker sidecar for running manifests)
- `index.html` — Vite entry
- `vite.config.ts` — Vite configuration
