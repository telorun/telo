---
---

Reset versioning for `std/ai` and `std/ai-openai` to align with the rest of the in-development standard library. Telo itself hasn't shipped 1.0.0, so these modules getting onto a 2.x / 1.x track was accidental and never reflected stability. Reset:

- `std/ai` manifest `2.0.0` → `0.1.0`; `@telorun/ai` package.json `2.0.0` → `0.1.0`; PURLs in `modules/ai/telo.yaml` updated to match.
- `std/ai-openai` manifest `1.1.3` → `0.1.3`; `@telorun/ai-openai` package.json `1.1.3` → `0.1.3`; PURL in `modules/ai-openai/telo.yaml` updated to match.

Manual unpublish required on npm for the abandoned versions:

- `@telorun/ai`: `1.1.0`, `1.1.1`, `2.0.0`
- `@telorun/ai-openai`: `1.1.0`, `1.1.1`, `1.1.2`, `1.1.3`

Empty changeset because every version field is set manually — there is no automated bump to trigger.
