---
"@telorun/studio": patch
---

Opening a workspace no longer crashes the editor with "Maximum update depth exceeded" (React error #185). The workspace bridge the editor registers with the authoring agent was rebuilt on every render, and each registration re-rendered the editor in turn; it is now rebuilt only when the workspace root changes.
