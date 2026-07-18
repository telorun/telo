# Telo Hub — registration frontend

A standalone React + Vite SPA for registering a Telo module ref with the
federated discovery hub. Deployed as static assets to GitHub Pages at
`hub.telo.run`; it POSTs to the hub's open `/register` verb on `telo.sh`
cross-origin. Pure static hosting — the hub app ([`apps/hub`](../hub)) is never
in the frontend's serving path.

Same UI idiom as [`apps/telo-editor`](../telo-editor): Radix primitives
(`radix-ui`) in `src/components/ui/*`, `lucide-react` icons, Tailwind v4 tokens
in `src/app/globals.css`. No Tauri — it's a browser app.

## Develop

```sh
pnpm --filter @telorun/hub-web dev
```

By default the app targets the production hub API (`https://telo.sh`). Point it
at the local docker-compose hub instead:

```sh
VITE_HUB_API=http://localhost:8040 pnpm --filter @telorun/hub-web dev
```

## Build

```sh
pnpm --filter @telorun/hub-web build   # → dist/ (static assets)
```

## Deploy

`.github/workflows/hub-pages.yml` builds `dist/` and publishes it to the
[`telorun/hub`](https://github.com/telorun/hub) GitHub Pages repo
(`cname: hub.telo.run`) on pushes to `main` that touch this app — mirroring the
editor's `editor.telo.run` pipeline. It needs a `HUB_PAGES_TOKEN` repo secret
with push access to `telorun/hub`, and the `hub.telo.run` DNS `CNAME` pointing at
GitHub Pages.
