---
"@telorun/cli": minor
"@telorun/kernel": minor
"@telorun/analyzer": minor
---

`telo publish` refuses to move the pin of a published version: when the `telo.yaml` it is about to push differs from the one already published at that `metadata.version`, the publish (and `--dry-run`) fails, naming `<destination>@<version>`, both pins, and each payload layer that moved — or that the manifest itself changed. Identical bytes still republish. Previously only payload layers were compared, so a manifest-only edit silently re-pinned a published version.

`telo publish --annotation <key>=<value>` (repeatable) writes author annotations onto the pushed OCI manifest beside the ones derived from `metadata`; a derived key is refused naming the `metadata` field to set, and the pushed set replaces the published one. Transports gain `checkAuthoredAnnotations` / `publishedAnnotations` and `PublishOptions.annotations`.

`telo module manifest --json` reports a `Telo.Application`'s declared `variables`, `secrets` and `ports` as `application` (`null` for a library), read by the analyzer's new `readApplicationContract`; no secret value is ever included.
