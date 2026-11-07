---
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

A child application — one started by a resource whose kind declares `x-telo-application-source`, such as `App.Instance` — is now packaged with its parent: `telo package` carries its manifest, files, import closure and built local modules, runs the portability check over them, lists them in `telo package inspect`, and the packaged app starts the child offline from the payload's sealed cache. Under a parent with `TELO_HOST_STATE_DIR` the child receives its own state directory, `<state dir>/apps/<module path and name>` (`apps/web`, `apps/Admin.web`), as its `TELO_HOST_STATE_DIR` instead of losing it, and the orphan rule covers `apps/` as it covers `needs/`: a renamed instance leaves its directory behind, which is `ERR_NEED_ORPHANED` when the load would create a fresh one and `NEED_ORPHANED` otherwise. A child never asks for a missing input; the refusal at its start now names the instance and the two repairs, supplying it under the instance or declaring it on the root, which asks.
