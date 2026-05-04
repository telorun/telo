---
---

Reset versioning for `std/http-server` to align with the rest of the in-development standard library. Telo itself hasn't shipped 1.0.0, so the module getting onto a 1.x / 2.x track was accidental. Reset:

- `std/http-server` manifest `2.0.0` → `0.3.0`; `@telorun/http-server` package.json `1.0.0` → `0.3.0`; PURLs in `modules/http-server/telo.yaml` updated to match. `0.3.0` was chosen because npm already has `@telorun/http-server@0.1.0` through `0.2.4` published, so `0.3.0` is the next clean slot below 1.0.
- Also fixed a stale registry-ref example in `cli/README.md` (`std/http-server@1.0.1` → `std/http-server@0.3.0`); the prior version never actually existed on the Telo registry.
