# `fs` Module — Local Filesystem Access

## Problem

A running Telo app has no way to read, write, list, or delete files on a local workspace — `s3` covers remote object storage and `JavaScript.Script` is sandboxed (no `fs`). The authoring agent ([ai-authoring-agent-first-step](../../../apps/authoring-agent/plans/ai-authoring-agent-first-step.md)) needs file tools, and filesystem access is a generic stdlib primitive many modules will want. This module provides a local filesystem surface.

## Solution

A new `std/fs` `Telo.Library` in `modules/fs/telo.yaml` defining six `Telo.Invocable` kinds, with controllers in `@telorun/fs` (`modules/fs/nodejs/`, Node `fs/promises`):

| Kind | Invoke input | Result |
|---|---|---|
| `Fs.File` | `{ path, encoding? }` | `{ content, size }` |
| `Fs.FileWrite` | `{ path, content, encoding?, createParents? }` | `{ bytesWritten }` |
| `Fs.FileEdit` | `{ path, oldString, newString, replaceAll? }` | `{ replacements }` |
| `Fs.DirectoryListing` | `{ path?, recursive? }` | `{ entries: [{ name, path, type, size }] }` |
| `Fs.DirectoryCreation` | `{ path, createParents? }` | `{ created }` |
| `Fs.FileRemoval` | `{ path, recursive? }` | `{ removed }` |

Each resource carries an optional compile-time `cwd` field (the base directory invoke paths resolve against; defaults to the process working directory, against which a relative `cwd` also resolves; `x-telo-eval: compile` so it can be a `!cel` value). Each kind declares its invoke `inputType` / `outputType` so `Ai.Tools` wiring and CEL type-checking see the real shapes. Text is UTF-8 by default; `encoding: base64` carries binary.

Errors are typed and surfaced, never swallowed: missing file (`ENOENT`) and permission (`EACCES`) each raise an actionable error naming the offending path; an `Fs.FileEdit` whose `oldString` is absent or matches ambiguously fails rather than silently no-op.

Consumers wrap these as `Ai.Tools` (the agent) or invoke them directly inside a `Run.Sequence`.

## Decisions

- **Six invocables, flat, `cwd` per resource** — slice-1 simplicity. (Rejected for now: a `Fs.FileSystem` abstract holding `cwd` once with operations referencing it — an additive DRY consolidation deferrable later without a redesign. Cost is one `cwd:` line per resource.)
- **Buffered, not streaming** — slice-1 targets are small manifest files; an `x-telo-stream` reader/writer for large files is a later, additive change.
- **UTF-8 default + `base64` escape hatch** — handles text manifests now and binary without a separate kind.
- **`FileEdit` is string-replacement, not diff or structured patch** — byte-level exact `oldString`→`newString` preserves comments and `!cel` tags that re-serializing a parsed manifest would mangle, and unified-diff hunk-matching is too brittle for an agent to emit reliably. `FileWrite` stays for create / full-rewrite; the two pair like an editor's write vs. edit.
- **Node `fs/promises` controllers** — the module runs in the kernel/runner (Node), not the browser-safe analyzer, so Node built-ins are fine.

## Example

```yaml
kind: Fs.File
metadata: { name: ReadFile }
cwd: ./workspace
---
kind: Fs.FileWrite
metadata: { name: WriteFile }
cwd: ./workspace
---
kind: Fs.FileEdit
metadata: { name: EditFile }
cwd: ./workspace
---
kind: Fs.DirectoryCreation
metadata: { name: MakeDir }
cwd: ./workspace
# invoked from a Run.Sequence (or wrapped as an Ai.Tools tool):
#   - name: Read
#     invoke: !ref ReadFile
#     inputs: { path: telo.yaml }        # → { content, size }
#   - name: Edit
#     invoke: !ref EditFile
#     inputs: { path: telo.yaml, oldString: "version: 1", newString: "version: 2" }  # → { replacements }
```

## Build & housekeeping

- `modules/fs/telo.yaml` (`Telo.Library`, `std/fs`) + `modules/fs/nodejs/` controllers (`@telorun/fs`).
- Tests in `modules/fs/tests/*.yaml`: read / write / edit / list / create-dir / delete happy paths, plus missing-file and failed-edit (absent / ambiguous match) error cases. Fixtures under `modules/fs/tests/__fixtures__/`. Run via `pnpm run test`.
- Docs in `modules/fs/docs/`, wired into `pages/docusaurus.config.ts` (`include`), `pages/sidebars.ts`, with `sidebar_label` frontmatter.
- Versioning: changie `Added` fragment (`changie new --project fs`); changeset for `@telorun/fs`; regenerate `.changie.yaml`.

## Out of scope

The `Fs.FileSystem` abstraction; streaming large-file I/O; file watching (editor-side reconciliation lives in the parent plan).
