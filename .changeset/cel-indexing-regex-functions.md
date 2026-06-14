---
"@telorun/templating": minor
---

Add eight pure (browser-safe, non-host) CEL standard-library functions to the single-source catalog, so both the runtime and the analyzer pick them up automatically:

- **Indexing** — `range(int): list<int>` (the one previously-missing primitive: materializes indices for an unknown-length list, e.g. `range(size(xs)).map(i, …xs[i]…)`) and `enumerate(list): list` (pairs each element with its zero-based position as `{index, value}`).
- **Regex** — `regexReplace(s, pattern, replacement, flags?)` (replaces every match by default, `$1` backrefs), `regexExtract`, `regexExtractAll`, and `regexGroups`.
- **Affixes** — `trimPrefix` / `trimSuffix` strip a fixed affix when present.
