---
"@telorun/k8s-runner": patch
---

`RUNNER_KEEP_FAILED_PODS=true` now keeps a failed session pod on every path that deleted it, not only a failed start: a container that ended or a supervisor lost after start, the replacement a later create makes, and the orphan sweep. A kept pod is relabelled `telo.run/kept-session=<id>` in place of its session and managed-by labels, so no lookup, replacement or sweep selects it again; delete it by hand once inspected. A pod that has not failed is deleted as before.
