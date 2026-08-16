---
"@telorun/kernel": patch
---

The disk cache is anchored by whole scheme, so a manifest source with no local
anchor no longer invents one. `resolveEntryDir` tested only for `http(s)` and let
every other scheme fall through to `path.resolve`, which reads it as a relative
path: a `memory://app/telo.yaml` entry anchored its analysis stamp and compiled
validators at `<cwd>/memory:/app/.telo`. On POSIX that is a legal directory name,
so the kernel silently created one inside whatever directory it was run from and
the cache appeared to work — a checkout accumulated a stray `memory:` tree. On
Windows `:` is illegal in a filename, so the same load failed at `mkdir` and
reported as a best-effort cache warning on every load. `oci://` had the same
shape.

A transient or remote source has no local anchor by construction, which is what
the scheme test now says, and it covers any scheme added later. Windows drive
letters are excluded by requiring a second character: `D:\src` satisfies RFC
3986's scheme grammar, and no registered scheme is one letter.
