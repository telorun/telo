---
"@telorun/kernel": patch
---

Bundle controller loader: self-heal a stale `node_modules/@telorun/sdk` realm
symlink instead of leaving it broken. A link that points somewhere other than
this kernel's SDK copy — e.g. the absolute host symlink a local run writes, then
bind-mounts into a container where that target path is absent — is now detected
(via `lstat`/`readlink`, which `existsSync` couldn't, since it follows the link)
and replaced. Fixes `pkg:telo/local/js` bundled controllers failing to load with
`Cannot find package '@telorun/sdk'` under `pnpm run test:docker` after a local
test run.
