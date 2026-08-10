---
"@telorun/editor": patch
---

Imports view re-pins an upgraded import instead of announcing it dropped the pin.

The hub reports an integrity pin per version on `GET /module/versions`, and `fetchHubVersions` already parsed it — the Imports view then discarded it in three places, mapping every response down to bare version names and rewriting the source with `withRefVersion` alone, which sheds the fragment pin. Every upgrade therefore came out unpinned, with a banner telling the user to run `telo upgrade` to recover what the editor was holding all along. The VS Code lens had done this correctly since it landed; the editor's model/AST path never picked it up.

Upgrading now folds the target version's published pin into the new source, so an already-pinned import stays pinned and an unpinned one gains a pin — the same outcome `telo upgrade` produces. The banner survives for the case it was written for: the hub publishes no hash for the version being moved to.

Where the pin lands follows the shape the author wrote. An entry with an `integrity:` sibling keeps it (its value is replaced in place); everything else carries a `#sha256-…` fragment on the source. `ParsedImport` gained `integrity` so the sibling form is visible at all — an object-form pin previously read as "not pinned", so it was deleted silently, with not even the banner to show for it.
