# Telo Editor

Desktop manifest editor for [Telo](https://github.com/telorun/telo). Opens a
workspace directory, parses its YAML manifests, runs static analysis through
the shared `@telorun/analyzer` package, and provides Topology, Inventory,
Source, and Deployment views for editing resources.

Built as a React + Vite SPA wrapped in a [Tauri](https://tauri.app) shell.

## Development

Run the Vite dev server on its own (browser-only, no native shell):

```bash
pnpm dev
```

Run the full Tauri desktop shell against the dev server:

```bash
pnpm tauri dev
```

## Building

```bash
pnpm build          # Vite build → dist/
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
