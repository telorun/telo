---
"@telorun/sdk": patch
---

Fix the broken `structured-errors.md` link in the README. It was a relative path
into `modules/run/docs/`, which resolves from a repo checkout but not from the
published package or the docs site; it now points at the file on GitHub. README
text only — no API change.
