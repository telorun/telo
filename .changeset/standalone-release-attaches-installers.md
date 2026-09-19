---
"@telorun/cli": patch
---

Fix the standalone release so a `v<version>` release cannot be published without its installers.

Five of the seven build targets failed, so nothing was ever attached — and the release existed anyway, because the npm job creates it. It is now created as a draft and published only after every target has built and the packages have installed in containers with no Node.js; `releases/latest`, which the install scripts read, skips drafts, so a failed build leaves the previous release standing.

The four build failures behind it: Windows runners have PowerShell and not `zip`; the runner's own Node decided which runtime archive was fetched, and a Node 22 image asked for a musl build that does not exist, so the runtime the binary carries is pinned and checked against all seven targets; esbuild's per-target executable was installed by a workflow step naming two of the four cross-builds, and is now fetched by the build itself; and `rpmbuild` refuses a `BuildArch` its builder cannot run, so the architecture moved onto the command.

No change to what the package ships — `bin` and `dist` are untouched. The version moves because the release workflow is triggered by it, and that is what carries the fix into the next release.
