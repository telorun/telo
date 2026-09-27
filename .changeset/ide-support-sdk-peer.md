---
"@telorun/ide-support": patch
---

Fixed: `@telorun/ide-support` declares `@telorun/sdk` as a peer dependency, as `@telorun/analyzer` and `@telorun/templating` (which it depends on) already require it. Before, a package manager installed the missing peer on its own, which made `pnpm deploy` of the CLI fail between a version bump and its publish.
