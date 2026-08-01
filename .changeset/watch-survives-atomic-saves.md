---
"@telorun/cli": patch
---

`telo run --watch` keeps reloading after an editor's atomic save.

Watch mode reloaded a few times and then went permanently silent. `fs.watch` binds to the file's **inode**, not to its path, so the save style most editors and formatters use — write a temp file, then rename it over the target — leaves the watcher attached to the replaced inode. It never fires again, and it emits no `error` event, so the re-establish handler never ran and `sync` skipped the path as already watched. Every file died on its first atomic save, which is why the session survived exactly as many reloads as it happened to get in-place writes.

The watcher now records the inode it is bound to and re-binds when it changes. The event that accompanies the replacement is the dying watcher's last gasp, which is enough to notice and re-arm — the strategy chokidar uses. The check is keyed on the inode rather than on a `rename` event type, because bun reports the replacement as `change`, so a rename-keyed variant would do nothing under the runtime the CLI actually runs on.

A change arriving while no cycle was waiting on its gate — during teardown and the next load, which take seconds — is no longer dropped. It was resolving an already-settled promise; it is now held and consumed by the next cycle, so an edit made while the app is restarting still triggers the reload it should.
