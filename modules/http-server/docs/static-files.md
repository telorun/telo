# Serving static files & frontends

`Http.Static` is a `Telo.Mount` that serves a directory of files — a built
single-page app, plain HTML, images, fonts — directly from an `Http.Server`.
Mount it next to an `Http.Api` and a single application delivers both its API
and the UI that talks to it.

## Quick start

```yaml
kind: Http.Server
metadata: { name: Server }
port: 8080
mounts:
  - path: /api
    mount: !ref Api      # Http.Api — the backend
  - path: /
    mount: !ref Ui       # Http.Static — the frontend
---
kind: Http.Static
metadata: { name: Ui }
root: ./public
```

A request to `/index.html` serves `./public/index.html`; `/api/...` is routed to
the API. Mount order does not matter — each mount owns its path prefix.

## Where `root` resolves

A relative `root` resolves against the **manifest file that declares the
resource**, not the process working directory. This is what lets the frontend
ship co-located with the application: point `root` at the directory your build
emits (`./public`, `./dist`, `./web/build`) and the assets travel with the app.
An absolute path is used as-is.

## Shipping the assets to the registry

For `root: ./public` to work after `telo publish`, the app must declare those
files in a top-level `files:` list so they are bundled into the published
`module.tar.gz` (the registry artifact) — otherwise only `telo.yaml` is
published and `root` resolves to an empty directory on the consumer:

```yaml
kind: Telo.Application
metadata: { name: todo-app, version: 1.0.0 }
files:
  - public/**
# … Http.Static with root: ./public
```

`telo install` / `telo run` extract the bundle next to the cached manifest, so
`root` resolves the same way it does locally. See the CLI `telo publish` docs
for the full `files:` pattern semantics.

## Fields

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `root` | string (required) | — | Directory of files to serve, resolved relative to the manifest. |
| `index` | string | `index.html` | File served for a directory root request. |
| `spaFallback` | boolean | `false` | Serve `index` for any path that does not match a file. |
| `maxAge` | integer (seconds) | — | `Cache-Control: max-age`; omit for no caching directive. |
| `immutable` | boolean | `false` | Add the `immutable` directive (content-hashed filenames). |

ETag, conditional requests (`If-None-Match` / `If-Modified-Since`), range
requests, and MIME-type inference are handled automatically.

## Single-page apps

A client-routed app (React Router, Vue Router, …) needs every unmatched path to
return `index.html` so a deep-link refresh resolves on the client. Enable
`spaFallback`:

```yaml
kind: Http.Static
metadata: { name: Ui }
root: ./dist
spaFallback: true
maxAge: 3600
immutable: true
```

`GET /` and real files (`/assets/app-3f9a.js`) serve as-is; `GET /settings/profile`
— which is not a file on disk — returns `index.html` with a `200`, and the
client router takes over. Without `spaFallback`, unmatched paths `404`.

## Caching content-hashed assets

A typical bundler emits an `index.html` that should never be cached and hashed
assets (`app-3f9a.js`) that can be cached forever. Serve them with two mounts:

```yaml
mounts:
  - path: /assets
    mount: !ref Assets   # long-lived, immutable
  - path: /
    mount: !ref Shell    # the SPA shell, short cache + fallback
---
kind: Http.Static
metadata: { name: Assets }
root: ./dist/assets
maxAge: 31536000
immutable: true
---
kind: Http.Static
metadata: { name: Shell }
root: ./dist
spaFallback: true
```
