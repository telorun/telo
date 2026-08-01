---
"@telorun/cli": minor
"@telorun/analyzer": minor
---

`telo publish`: a bundled controller's entry point no longer has to be restated in `files:`.

`controllers:` already names it, so it joins the payload from there — matching the module-artifact spec, which defines a controller layer by its candidates' entry points and says nothing about `files:`. A module whose only payload is its controller now declares no `files:` at all, and `files:` keeps its role for what the manifest cannot otherwise name: assets, static files, sidecars. Symlink confinement moved from the pattern match to the whole partition, so it covers every file that actually ships.

`telo publish` also refuses to publish changed bytes at an unchanged `metadata.version`. A bundle inlines its dependencies, so a fix in a shared TS library — or a transitive bump the lockfile alone moved — changes a module's shipped bytes while touching no file under its own directory and moving no package version; no path-scoped rule and no version ledger can see that, and the fix would ship to nobody. Publish now builds the payload and compares each layer's `integrity` digest against the artifact already published under that version, naming the digest that moved. Exact rather than inferred: it cannot miss what no version records, and identical bytes hash identically so it cannot fire spuriously.

The analyzer accepts `local_path` as a known qualifier on a bundled-controller PURL. It names the source `path=` was built from, contributes nothing to the layer selector, and is inert in a published artifact.
