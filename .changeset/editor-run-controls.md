---
"@telorun/editor": patch
---

Run controls: the top-bar Run button now becomes a Stop button while a run is
live (one control, same slot) instead of showing a separate Stop or an
always-present Run that restarts; the run-panel Stop is removed. Also adds an
inline "Clear" action on the recent-runs dropdown header to clear finished run
history — a still-live run is kept so it isn't orphaned.
