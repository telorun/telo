---
"@telorun/cli": patch
---

`telo install` now hands each controller pre-install job its module's
`ModuleArtifact`, the same handle the kernel supplies at run time. Previously
the pass called the controller loader with no artifact, so every `pkg:telo`
bundled candidate of a published (`oci://`) module was env-missing and the
install failed on modules `telo run` loads fine — only legacy `pkg:npm`
modules passed. `warmModuleLayers` now returns the artifact handles it already
built (keyed by module source) instead of discarding them.
