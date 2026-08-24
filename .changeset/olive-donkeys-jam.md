---
"@telorun/studio": minor
---

Renamed Telo Editor to Telo Studio. The app moved to `apps/studio`, the package
is `@telorun/studio`, the desktop bundle is `telo-studio` with identifier
`com.telo.studio`, and the web build now deploys to `studio.telo.run` (releases
to the `telorun/studio` repo, tagged `studio-v*`).

Two consequences for existing users. The desktop app's new bundle identifier
makes it a distinct application: an installed Telo Editor will not update to
Telo Studio and both can be installed side by side.

Browser storage keys were renamed to a `telo-studio:<area>[:v<N>]` scheme. A
one-time migration at startup moves every key written under the old name, in
both stores — `localStorage` for workspaces, history, deployments, the run
index, settings and agent conversations, and `sessionStorage` for the per-tab
run resume cursors — so nothing is lost on upgrade. A key that cannot be
rewritten (an exhausted quota) is reported to the console and retried on a
later start; readers treat their own missing key as "no persisted state", so a
partial migration degrades rather than corrupts.
