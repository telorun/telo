---
"@telorun/studio": minor
---

The template gallery is now "Starters": the empty-workspace panel offers "Start from a starter", the new-module dialog lists starters, and a starter is fetched from `starters.json` (catalog key `starters`) under the new default `https://raw.githubusercontent.com/telorun/telo/refs/heads/main/starters`. The setting that overrides the source is `startersBaseUrl`; a value saved under the former `templatesBaseUrl` is read as `startersBaseUrl` on load. A custom gallery host must rename its `templates.json` to `starters.json` and its top-level `templates` key to `starters`.
