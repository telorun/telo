# @telorun/editor-protocol

The contract between an **editor host** (VS Code, telo studio, any LSP client)
and a **telo language-server engine** — the part of the conversation LSP itself
does not define. An editor edits a module against one chosen telo version; that
version's engine produces every diagnostic and language feature, and the host
supplies everything the engine cannot do itself: files, imports, the hub.

This README is the specification. The TypeScript types in `src/index.ts` and
[`editor-protocol-schema.json`](./editor-protocol-schema.json) (for hosts written
in other languages) are its projections; the package has no dependencies.

## The engine

Telo `X` publishes its engine as `@telorun/language-server@X`: one
self-contained ES module, `dist/language-server.mjs`, with no imports. Its
`package.json` declares `teloEditorProtocol`, the protocol generation the engine
speaks — a host offers only versions whose generation it speaks.

The module exports one entry:

```ts
serve(port: { postMessage(message): void; addEventListener("message", (event) => void): void }): void
```

`port` carries **LSP JSON-RPC message objects** (not framed text) in both
directions; the engine reads each message from `event.data`. A Web Worker scope,
a `MessagePort` and a Node `parentPort` adapted to `addEventListener` all fit.
The host loads the module into a worker, calls `serve(self)` there, and speaks
LSP to the worker.

**The engine performs no I/O of its own** — no `fetch`, no filesystem. Every
byte it reads arrives through the `telo/*` requests below, which is what lets one
build run in a browser, a desktop app and an extension host alike, and what
leaves transports, credentials, caches and integrity checks with the host.

## Handshake

The host sends a standard `initialize`. The engine answers:

- `serverInfo: { name: "telo", version: "<identity>" }` — the engine's
  **identity**. For a release build it is `X`, the telo version the engine
  implements (the surface generation `requires: telo:` ranges are written
  against) and exactly the version of the `@telorun/language-server` package it
  was published as. A build made while that release is still pending — a
  development checkout, a main-branch deployment — reports `X+unreleased`: it
  implements `X` but is not the `X` that will be published, so it never shares
  an identity with a published engine. A host orders identities and tests them
  against `requires: telo:` intervals by semver precedence (build metadata
  ignored), and tells engines apart by the whole string.
- `capabilities.experimental.telo.protocol: 1` — the generation it speaks.
- The standard capabilities it serves: full text sync, completion, hover,
  definition, rename with `prepareRename`, signature help, `semanticTokens/full`
  (the legend is in the capabilities), `codeAction` (quick fixes),
  `codeLens`, and `workspace/executeCommand` for the commands below.

A host verifies every handshake: `serverInfo.name` is `telo`, the protocol is a
generation the host speaks, and an engine the host downloaded as version `X`
reports exactly `X`. An engine failing any of these is refused, not run.

The engine reads the client's `workspace.codeLens.refreshSupport`,
`workspace.semanticTokens.refreshSupport` and
`workspace.didChangeWatchedFiles.dynamicRegistration` capabilities; with the
last it registers a watcher for `**/*.yaml` and re-analyses what a changed file
feeds.

## URIs

Documents are `file:` URIs; a remote module is named by its import source as
written (`oci://host/repo@1.2.0`, `https://…`). One `file:` location has many
spellings, so the protocol fixes **one canonical form** and identity is
equality of canonical forms:

- there is no query and no fragment;
- a local file has an empty authority (`file:///…`; `file://localhost/…` is the
  same location), and a file on a UNC share has the share's host as its
  authority, ASCII-lowercased and percent-encoded like a path segment —
  `\\ServerA\share\x` is `file://servera/share/x`, and the four-slash
  spelling `file:////ServerA/share/x` folds to that same form;
- the path is its UTF-8 bytes, each percent-encoded except the unreserved
  characters `A–Z a–z 0–9 - . _ ~` and `/`, with uppercase hex digits —
  `My Project (copy)` is `My%20Project%20%28copy%29`;
- a local Windows drive is written `/<lowercase letter>%3A/` — `C:\Users\u` is
  `file:///c%3A/Users/u`; the drive rule does not apply under a UNC host.

An engine emits every `file:` URI in canonical form. A host compares URIs only
by their canonical forms — a document the editor opened under another spelling
of the same location is the same document — and does not rewrite the URIs in
the messages it passes along.

## Host-served requests (engine → host)

A relative path is resolved against the **directory of the file** its `base`
names.

| Method | Params | Result |
| --- | --- | --- |
| `telo/read` | `{ uri }` | `{ uri, text }` — the text and the **canonical** location it was read from: a directory resolves to its `telo.yaml` (`TELO_MODULE_FILENAME`), an `oci://` tag to the reference the host resolved — or `null` when nothing exists at `uri`. |
| `telo/exists` | `{ base, relative }` | `boolean` — whether a file or directory exists there. |
| `telo/listDirectory` | `{ uri }` | `[{ name, kind }]`, or `null` when `uri` names nothing or a file. `kind` is `file`, `directory`, `symlink` or `other`, read without following links — a symbolic link is `symlink` whatever it points at. |
| `telo/hub/searchRefs` | `{ query }` | `[{ ref, latestVersion, description? }]` — refs the configured hub matches `query` against. |
| `telo/hub/listVersions` | `{ ref }` | `[{ version, integrity? }]`, newest first; `[]` for a ref the hub does not track. |

Any other failure — an unreachable registry, a hub that did not answer, a
permission error — is a **JSON-RPC error** carrying its reason, never a silent
`null`: the engine reports it (a load failure becomes a diagnostic; a failed hub
lookup is logged through `window/logMessage` and, where a user asked for it,
shown). Hub lookups feed completion and upgrade lenses only.

The engine expands `include:` globs itself, by walking `telo/listDirectory`
from the including file's directory — collecting `file` entries and descending
into `directory` ones, never through a link, as the kernel does — so a host
serves directories, never patterns, and every host matches a glob exactly as the
kernel does. `telo/read` and `telo/exists` do follow links.

Remote modules are read through `telo/read` like any document: the host owns
the transport (`oci://`, `https://`, a manifest cache) and any integrity check.
A candidate version an import upgrade considers is read as its versioned ref
(`oci://host/repo@1.3.0`).

## `telo/requirements` (engine → host notification)

Sent after each analysis of an **owner module** — a `telo.yaml`, or a manifest
analysed standalone:

```json
{
  "owner": "file:///ws/app/telo.yaml",
  "documents": ["file:///ws/app/telo.yaml", "file:///ws/app/routes.yaml"],
  "ranges": [
    { "module": "file:///ws/app/telo.yaml", "text": ">=0.100.0",
      "interval": { "min": { "version": "0.100.0", "inclusive": true } } },
    { "module": "oci://ghcr.io/telorun/sql@0.25.0", "text": ">=0.90.0 <0.120.0",
      "interval": { "min": { "version": "0.90.0", "inclusive": true },
                    "max": { "version": "0.120.0", "inclusive": false } } }
  ]
}
```

- `owner` — the owner module's URI.
- `documents` — the owner and every partial it includes. A host routes these
  documents to the engine it chose for `owner`.
- `ranges` — every `requires: telo:` range in the owner's import closure, one
  per declaring module. The owner declares one exactly when an entry's `module`
  equals `owner`. `interval` is the range reduced to its edges by the engine,
  through the analyzer's own range reader; an absent edge is open. A host only
  compares plain versions against it — it never parses a range.

A range the analyzer refuses as malformed is reported as a diagnostic and does
not appear here.

## `Diagnostic.data`

Every diagnostic the engine publishes may carry:

```ts
{ fix?: { replacement: string; tag?: "ref" | "cel" | "module-path" },
  resource?: { kind: string; name: string },
  path?: string }
```

`fix` is a mechanically applicable repair — the whole corrected value at the
diagnostic's range, written behind the YAML tag `tag` when present. A host
returns the diagnostic unchanged in a `textDocument/codeAction` request's
context, and the engine answers with the quick fix that applies it. `resource`
and `path` locate the offending value inside a manifest (a host may use them to
place a diagnostic on a form field). `Diagnostic.tags` carries LSP's
`Deprecated` / `Unnecessary`.

## Commands

| Command | Arguments | Effect |
| --- | --- | --- |
| `telo.upgradeImport` | `[{ uri, aliases }]` | Recomputes the document's import upgrades and applies those of `aliases` through `workspace/applyEdit`. |
| `telo.upgradeAllImports` | `[{ uri, aliases }]` | Same, for every alias the summary lens named. |
| `telo.refreshImportUpgrades` | — | Drops cached version lists and verdicts, then `workspace/codeLens/refresh`. |

The engine's code lenses over an `imports:` block name the first two.

## Generations

`TELO_EDITOR_PROTOCOL` is the generation this package describes (`1`).
**Additions within a generation are negotiated by capability**: a new request, a
new optional field or a new command is advertised by the side that has it and
used only when advertised, so an older host and a newer engine (or the reverse)
keep working. **An incompatible change bumps the generation**: a host speaking
generation `N` offers only engines whose `teloEditorProtocol` is `N`, and an
engine refuses nothing — it simply is not selected.

**A receiver must ignore what it does not know**, so that an addition within a
generation never breaks the other side: a member it does not know is ignored,
and an enumeration value it does not know is read as that enumeration's
least-capable value — a `telo/listDirectory` entry `kind` as `other` (neither
read as a file nor descended into), a `Diagnostic.data.fix.tag` as no fix
offered. `editor-protocol-schema.json` is written the same way: its objects are
open and its enumerations admit any string, so a message carrying a later
addition still validates.
