---
"@telorun/analyzer": minor
"@telorun/cli": minor
---

`telo run <app> --help` now also lists, under `Environment:`, every `variables:` / `secrets:` / `ports:` entry read from an environment variable alone — its type, its default or `required`, and the input it fills — so an application with no command-line arguments no longer answers with a bare `Usage: <name>`. A secret shows only its type and whether it is required. An application declaring `needs:` gets a last line naming them and pointing at `telo needs report`. `renderApplicationUsage` returns the same text.
