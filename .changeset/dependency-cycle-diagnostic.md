---
"@telorun/analyzer": minor
---

`telo check` reports a loop in the resource dependency graph as `DEPENDENCY_CYCLE` (error), one diagnostic per loop, anchored on a resource in it and tracing the loop in the same wording as the kernel's `ERR_CIRCULAR_DEPENDENCY`. Only loops with a resource in the entry's own modules are reported. Because `telo run` analyzes before booting, an application whose own resources form a loop now fails at load with this diagnostic instead of at boot.
