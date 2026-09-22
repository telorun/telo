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
root: !module-path ./public
```

A request to `/index.html` serves `./public/index.html`; `/api/...` is routed to
the API. Mount order does not matter — each mount owns its path prefix.

## What `root` names

`root` is a `Telo.HostPath`: an absolute directory on the machine running the
application. There are two ways to write one, and which you use says where the
files come from.

**Files that ship with the module** — a frontend, a built SPA — are written with
`!module-path`, relative to the module root (the directory holding `telo.yaml`):

```yaml
root: !module-path ./public
```

It resolves to wherever the module's files are on disk: the directory in a
checkout, the unpacked assets of a published artifact, the unpacked payload of a
packaged executable. `telo publish` and `telo package` carry the whole directory
with no `files:` entry, and refuse one that is missing or empty
(`MODULE_PATH_NOT_FOUND` / `MODULE_PATH_EMPTY`), which `telo check` reports too.

**Files on the host** — reports the application writes, an upload directory —
come from a variable typed `Telo.HostPath`. A relative value there is resolved
against the working directory, so the directory an application writes to and
the one it serves are the same:

```yaml
variables:
  reportsDir:
    env: REPORTS_DIR
    type: string
    x-telo-type: Telo.HostPath
    default: reports
---
kind: Http.Static
metadata: { name: Files }
root: !cel "variables.reportsDir"
```

A subdirectory of one is `root: !cel "variables.reportsDir.joinPath('daily')"` —
in CEL a host path is its own type, so it is extended with `.joinPath`, which
uses the host's separator, never with `+`, which would make it a plain string.

A plain relative literal (`root: ./public`) is refused: it names nothing fixed,
since the module's directory and the working directory are both plausible
readings. `telo check` reports it as `HOST_PATH_RELATIVE` and offers the
`!module-path` repair; a relative path an expression computes is refused when
the resource is created (`ERR_HOST_PATH_RELATIVE`).

## Lazy asset download

The optional `assets:` list marks files as the artifact's **asset layer**, which
is fetched on first access rather than up front — so a consumer that imports the
module for its API alone never downloads the frontend. A directory named with
`!module-path` is claimed into that layer already; `assets:` is needed only for
files nothing names.

## Fields

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `root` | `Telo.HostPath` (required) | — | Directory of files to serve — `!module-path` for one that ships with the module. |
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
root: !module-path ./dist
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
root: !module-path ./dist/assets
maxAge: 31536000
immutable: true
---
kind: Http.Static
metadata: { name: Shell }
root: !module-path ./dist
spaFallback: true
```
