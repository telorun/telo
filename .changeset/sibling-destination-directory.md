---
"@telorun/cli": patch
---

`telo publish` and `telo release` now give a relatively imported sibling the address of the path its manifest stands for. A `telo.yaml` is its directory's index, so `./timesheets` and `./timesheets/telo.yaml` both publish at `…/timesheets`. Any other manifest is addressed by its name without the extension, so `./example/app.yaml` publishes at `…/example/app`, and a relative import inside it resolves as it does on disk. A file-form import used to publish the sibling at `…/timesheets/telo.yaml`, one level deeper than its directory, so every relative import inside it resolved one level too deep, and a module reached through import chains of different depths was refused as "published to both" two addresses. Two manifests that would publish to one address (`example/app.yaml` beside `example/app/telo.yaml`) are now refused, naming both.
