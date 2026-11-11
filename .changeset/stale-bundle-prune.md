---
"@telorun/kernel": patch
---

A source-built controller bundle is no longer deleted the moment a newer build replaces it. Kernels sharing one `.telo` cache (the test suite spawns one per manifest) could lose a bundle's directory while another was still writing its generated packages or importing it, failing that start. Bundle directories no build refers to are now removed once they have been idle for ten minutes.
