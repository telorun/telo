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
| `ctx.resolveControllerBrowserEntry(specifier)` | the module declaring the **kind** — the code the controller's own module ships — and, when that module declares no such entry, the one module it imports directly that does |
| `ctx.resolveBrowserEntry(specifier)` | the module that declared the **resource** — the code its author named |

A controller can therefore serve an entry a library it imports ships: a renderer
importing a library of contract code reaches that library's entry by its
specifier, with no copy in its own module. Only direct imports are searched, and
only when the controller's own module does not declare the specifier — its own
entry always wins. Two direct imports declaring it is `ERR_BROWSER_ENTRY_AMBIGUOUS`,
naming both modules; none is `ERR_BROWSER_ENTRY_UNKNOWN`.

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
      x-telo-browser-export:
        entry: /entry
        abi: [ui-1]
        external: [react, react/jsx-runtime]
```

| Key | | |
| --- | --- | --- |
| `entry` | required | A JSON Pointer, relative to the object holding the annotated field, to the sibling string that names the browser entry's `specifier`. |
| `abi` | optional | The generations the kind accepts, each `<family>-<version>`. The named entry's `abi` must be one of them; an entry declaring none is refused. |
| `external` | optional | The bare specifiers the kind supplies to the entry. Every specifier the named entry lists under its own `external` must be one of them. |

Without `abi` or `external` the entry's generation or imports are not checked.
A resource then reads:

```yaml
kind: Ui.Component
metadata:
  name: statusPill
entry: "@acme/badges"
export: StatusPill
```

The specifier must be one the module **declaring the resource** lists under
`exports.browser`, the entry one the kind accepts, and the export one that entry
lists under `exports`:

| | at `telo check` | at creation |
| --- | --- | --- |
| the module declares no such entry | `BROWSER_ENTRY_UNKNOWN` | `ERR_BROWSER_ENTRY_UNKNOWN` |
| the entry's `abi` is not one the kind lists | `BROWSER_ENTRY_ABI_UNSUPPORTED` | `ERR_BROWSER_ENTRY_ABI_UNSUPPORTED` |
| the entry's `external` lists a specifier the kind does not supply | `BROWSER_ENTRY_IMPORT_UNSUPPLIED` | `ERR_BROWSER_ENTRY_IMPORT_UNSUPPLIED` |
| the entry declares no such export | `BROWSER_EXPORT_UNKNOWN` | `ERR_BROWSER_EXPORT_UNKNOWN` |

The first three are reported at the field naming the entry, the last at the
field naming the export. A resource an imported library declares is judged the
same way, against that library's own entries, and reported at the `imports:`
entry through which the library is first reached — the run is refused all the
same, and that is the line the importer can act on. A value written as an
expression is judged when the resource is created.

An entry another module ships under the same name does not count. A resource
names code its own module ships, which is also what `ctx.resolveBrowserEntry`
resolves.

The annotation itself must be `{ entry, abi?, external? }` with `entry` a JSON
Pointer, `abi` a non-empty list of `<family>-<version>` and `external` a list of
non-empty strings. Anything else is `BROWSER_EXPORT_ANNOTATION_INVALID` at the
kind that writes it — at the `imports:` entry reaching it for an imported
library's kind — and `ERR_BROWSER_EXPORT_ANNOTATION_INVALID` when the kernel
registers the kind.

## In a published module

`telo publish` and `telo release` build every entry with the same builder and
put the results in a `browser` layer — one per distinct `abi` — holding each
entry, its chunks and stylesheet, and the `<path>.siblings.json` listing them.
Nothing needs a `files:` entry. A runtime fetches a browser layer only when one
of its entries is resolved; `telo install` and `telo package` always include it,
since it is the same on every platform. The Rust kernel skips browser layers.
