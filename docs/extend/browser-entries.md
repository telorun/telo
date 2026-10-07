---
sidebar_label: Browser Entries
slug: /extend/browser-entries
description: "Ship code for a browser with a module — ES modules declared under exports.browser, built by the kernel, packaged in their own artifact layer, and named from a resource with a checked export."
---

# Browser entries

A module can ship code that runs in a page: a renderer, a component, a client
for the API its controllers serve. `exports.browser:` is where it says so. An
entry is built by the kernel — from source in a checkout, at publish for a
release — and a controller asks for it by name and serves what it gets.

A browser entry is never imported by a kernel. It is data a controller hands to
a browser, which is why it has its own block and its own layer rather than
riding in `exports.code:`.

## Declaring an entry

```yaml
kind: Telo.Library
metadata:
  name: Badges
  version: 1.0.0
exports:
  browser:
    - specifier: "@acme/badges"
      path: ./browser/badges.js
      source: ./browser/src/badges.tsx
      abi: ui-1
      external: [react, react/jsx-runtime]
      exports: [StatusPill]
```

| Field | | |
| --- | --- | --- |
| `specifier` | required | The name the entry is imported by — a key of the page's import map — and the name a resource refers to it by. One entry per specifier. |
| `path` | required | Where the built file goes, relative to the module root. `.js` or `.mjs`. |
| `source` | required in a checkout | The file `path` is built from. |
| `abi` | optional | `<family>-<version>`: the contract between the entry and the page that loads it. A host compares it with its own and decides what a mismatch means. |
| `external` | optional | Bare specifiers the **host** supplies through its import map. They stay imports in the output; everything else the entry imports is bundled into it. |
| `exports` | optional | The export names a resource may name. The build fails if the entry lacks one. |

There is no `format` — a browser entry is always an ES module — and no `os`,
`arch` or `libc`: it is one file for every platform. Writing any of them, a
malformed entry, a specifier declared twice, or a `path` or `source` that is
absolute or points above the module root is `BROWSER_ENTRY_INVALID` — and the
entry does not exist for anything that names its specifier.

`exports:` is a `Telo.Library` block, so a browser entry belongs to a library.
An application that needs one puts it in a library it imports.

## How entries are built

The kernel builds an entry as an ES module for a browser: ES2022, the automatic
JSX runtime, the `source` export condition (so a workspace package is bundled
from its sources), and `process.env.NODE_ENV` set to `"production"`. A
stylesheet the sources import is emitted as a file beside the entry.

**Entries that declare the same `external` list are built together**, with code
splitting, so what they share ends up in one chunk both import:

```yaml
exports:
  browser:
    - { specifier: "@acme/badges", path: ./browser/badges.js, source: ./src/badges.tsx, external: [react] }
    - { specifier: "@acme/charts", path: ./browser/charts.js, source: ./src/charts.tsx, external: [react] }
```

That is how two entries of one module come to share a dependency. Listing the
dependency as `external` in one entry and bundling it in the other does not work
for a CommonJS package, which is wrapped at build time and cannot be reached
through an import a browser resolves. Entries with different `external` lists
are separate builds and share nothing.

In a source checkout an entry is built the first time something asks for it, into
`<cache-root>/browser-src/`, and rebuilt when any file the build read changes. A
build that fails is `ERR_BROWSER_BUILD_FAILED`, and there is no prebuilt file to
fall back to.

## Reaching an entry from a controller

```ts
const entry = await ctx.resolveControllerBrowserEntry("@acme/renderer");
```

| Method | Resolves against |
| --- | --- |
| `ctx.resolveControllerBrowserEntry(specifier)` | the module declaring the **kind** — the code the controller's own module ships |
| `ctx.resolveBrowserEntry(specifier)` | the module that declared the **resource** — the code its author named |

Both return the same shape:

| Field | |
| --- | --- |
| `file` | `file://` URI of the built ES module |
| `siblings` | `file://` URIs of everything else it loads: shared chunks, and its stylesheet |
| `digest` | a content digest over all of those files — it changes when any byte a page would load does |
| `abi`, `external`, `exports` | as the entry declares them |

The siblings keep their place relative to the entry, which imports its chunks by
relative path — serve them the way they sit on disk. `digest` is what a
content-addressed URL or an `ETag` is made from. A consumer that serves an
entry's files reads them when it resolves them, and serves those bytes: in a
checkout the build cache may delete a superseded build, so a path kept for a
later read can be gone.

Both methods are served by the Node kernel only.

What an entry loads is recorded by its build in a file beside it,
`<path>.siblings.json`:

```json
{ "files": [ { "path": "browser/chunks/shared-4F2A.js" } ] }
```

Each `path` is relative to the module root. The kernel serves only what that
list names, and only when every path is a regular file inside the directory the
entry was built or extracted into: a list that is missing, is not this shape, or
names a file outside that directory is `ERR_BROWSER_ENTRY_UNAVAILABLE`. The name
is reserved — `telo publish` and `telo package` refuse a module that declares
its own file at `<path>.siblings.json`.

## Naming an export from a resource

A kind lets its resources name an export of a browser entry with
`x-telo-browser-export`:

```yaml
kind: Telo.Definition
metadata:
  name: Component
schema:
  type: object
  properties:
    entry: { type: string }
    export:
      type: string
      x-telo-browser-export: { entry: /entry }
```

`entry` is a JSON Pointer, relative to the object holding the annotated field,
to the sibling string that names the browser entry's `specifier`. A resource then
reads:

```yaml
kind: Ui.Component
metadata:
  name: statusPill
entry: "@acme/badges"
export: StatusPill
```

The specifier must be one the module **declaring the resource** lists under
`exports.browser`, and the export one that entry lists under `exports`:

| | at `telo check` | at creation |
| --- | --- | --- |
| the module declares no such entry | `BROWSER_ENTRY_UNKNOWN` | `ERR_BROWSER_ENTRY_UNKNOWN` |
| the entry declares no such export | `BROWSER_EXPORT_UNKNOWN` | `ERR_BROWSER_EXPORT_UNKNOWN` |

An entry another module ships under the same name does not count. A resource
names code its own module ships, which is also what `ctx.resolveBrowserEntry`
resolves.

## In a published module

`telo publish` and `telo release` build every entry with the same builder and
put the results in a `browser` layer — one per distinct `abi` — holding each
entry, its chunks and stylesheet, and the `<path>.siblings.json` listing them.
Nothing needs a `files:` entry. A runtime fetches a browser layer only when one
of its entries is resolved; `telo install` and `telo package` always include it,
since it is the same on every platform. The Rust kernel skips browser layers.
