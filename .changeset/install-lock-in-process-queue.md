---
"@telorun/kernel": patch
---

Stop `telo install` printing a wait notice per controller.

Package installs dedupe per alias, so N controllers are N `withInstallLock`
calls against the same install root. They all contended through the filesystem
lock: one won, and the rest polled `fs.open` for the duration of the install,
each crossing the notice threshold and printing "waiting for controller install
lock". A 52-controller `telo install` emitted 51 of them — while the holder was
the very same process, which is not what the notice means.

Same-process callers now queue in memory ahead of the filesystem lock, so
exactly one reaches it per process. The notice regains its cross-process
meaning, and the queued callers do no lock I/O at all.
