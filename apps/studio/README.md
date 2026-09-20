# Telo Studio

Desktop manifest editor for [Telo](https://github.com/telorun/telo). Opens a
workspace directory, parses its YAML manifests, runs static analysis through
the shared `@telorun/analyzer` package, and provides Graph,
Outline, Run, and Source views for editing resources.

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
