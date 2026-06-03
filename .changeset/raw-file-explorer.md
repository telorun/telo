---
"@telorun/editor": minor
---

Add a raw file explorer and unified open-editors tabs. The left sidebar now shows the full workspace file tree (create/rename/delete/drag-move, with selection driving where new files land and top-level folders expanded by default), backed by a new `rename` workspace-adapter primitive across the Tauri, File System Access, and localStorage backends. The center pane is now a VSCode-style tab strip: module tabs host the structured views while non-telo files open in a Monaco editor (binary files show a placeholder). Open tabs, the active tab, and expanded folders persist across reloads, and structural file ops re-scan the workspace so the Applications/Libraries view stays in sync. Imports, Definitions, Resources, and Kinds moved from the sidebar/Inventory into dedicated module-view tabs (Imports keeps add/remove and the version-upgrade dropdown); the Inventory view and the redundant file-path/module-path labels were removed.
