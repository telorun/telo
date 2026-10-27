---
"@telorun/cli": minor
---

`telo runner` runs the co-resident agent named by `AGENT_MODULE_REF` as a `telo run` process in each session that asks for it, advertises it in `features.agents`, refuses `AGENT_IMAGE` at boot, and keeps the runner's `AGENT_*` variables out of every application run.
