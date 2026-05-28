---
"@telorun/editor": minor
---

Rework run handling to support one session per application with per-application
run history. Starting a second run no longer crashes the editor with a blank
screen (`RunIo.open() may be called only once`): a per-run terminal buffer now
owns the single transport open and replays its transcript into the view, so runs
stay re-viewable across remounts. The Run button gains a chevron dropdown listing
the active application's recent runs; selecting one opens its output.
