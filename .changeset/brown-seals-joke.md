---
---

Telo editor internal refactor. No behaviour change; public API surface preserved via re-exports from `apps/telo-editor/src/loader.ts`.

- Dedupe helpers: consolidated 10 local `isRecord` definitions to a shared `lib/utils.ts`; 4 `isTerminal` copies to `run/types.ts`; dropped the byte-identical `getTopologyRole` copy in `RouterTopologyCanvas.tsx`.
- Docs cleanup: rewrote `apps/telo-editor/README.md` (was `create-next-app` boilerplate) to describe the actual Vite + Tauri app; dropped dead `ARCHITECTURE.md` links from `plans/reference-bindings-canvas.md`.
- Split the 1811-line `loader.ts` into nine purpose-scoped files under `loader/` — `paths.ts`, `registry.ts`, `parse.ts`, `ast-ops.ts`, `crud.ts`, `open.ts`, `queries.ts`, `subgraph.ts`, and `adapters/{tauri-fs,fsa,local-storage}.ts`. `loader.ts` shrank to 232 lines (entry + barrel), with a clean one-way dependency graph and no import cycles.
