---
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/analyzer": minor
"@telorun/http-server": patch
---

Templated definitions can now produce a mountable HTTP surface, and their dispatch targets are created once instead of per call.

- **`mount:` template dispatch** — a `Telo.Definition` with `capability: Telo.Mount` may declare `mount: <child>` (sibling to `invoke:` / `run:` / `provide:`) naming a `resources:` entry that is itself a `Telo.Mount` (e.g. an `Http.Api`). The template instance's `register()` delegates to that persistent child, so a library can ship a self-contained, declarative HTTP resource. The analyzer validates the new field (`MOUNT_ON_NON_MOUNT`, `MOUNT_DISPATCHER_CONFLICT`, `MOUNT_TARGET_UNKNOWN`, `MOUNT_TARGET_NOT_MOUNTABLE`).
- **Persistent dispatch targets** — the template controller no longer re-creates its `invoke:` / `run:` / `provide:` target on every call (`withEphemeral` is removed). Every `resources:` entry is created once at `init()` and reused; per-call data flows exclusively through the top-level `inputs:` sibling. A resource body may reference only `self`; `${{ inputs.* }}` inside a target body is no longer supported (move it to the top-level `inputs:`).
- **Library-scoped child resolution** — a template's `resources:` are spawned in a child context rooted on the *defining* library's module context (new `EvaluationContext.spawnChildContext()`), so their internal kind aliases and `!ref`s resolve against the library's own imports rather than the consumer's.
- **http-server** — a route declared at `/` now sits at the mount root (`/todos` + `/` → `/todos`) instead of a trailing-slash variant Fastify treats as a distinct, unmatched URL, so collection-style mounts respond at the mount path itself.
