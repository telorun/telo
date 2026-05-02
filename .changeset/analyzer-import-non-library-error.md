---
"@telorun/analyzer": patch
---

Surface a clear error when a `Telo.Import` target does not resolve to a `Telo.Library`. Previously the loader silently dropped the import when the fetched manifest contained no library doc, which produced misleading downstream `UNDEFINED_KIND` diagnostics on every kind the import was supposed to provide. Now the loader throws with the resolved URL and the kinds it actually found, so the failure points at the real cause. The built-in `RegistrySource` additionally detects S3/R2-style XML error bodies served with a `200` status and surfaces the upstream code/message rather than letting the body parse as YAML.
