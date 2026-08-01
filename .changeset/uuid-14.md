---
"@telorun/templating": patch
---

Upgrade `uuid` to v14, clearing the deprecation warning on `npm i -g @telorun/cli`.

`uuid@10` is deprecated upstream ("uuid@10 and below is no longer supported"), and since `@telorun/cli` depends on `@telorun/templating`, npm printed that warning on every global CLI install. The CEL stdlib calls `v1`/`v3`/`v4`/`v5`/`v6`/`v7`/`validate`/`version` with no options or caller-supplied buffers, so none of the breaking changes between v10 and v14 — CommonJS removal, the `v1`/`v7` internal-state refactor, the `offset` bounds check on `v3`/`v5`/`v6` — reach any call site. v14 requires Node 20+ and TypeScript 5.4+, both below what this repo already demands.

The `@types/uuid` devDependency is dropped: uuid has shipped its own types since v11.
