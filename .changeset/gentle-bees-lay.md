---
---

Docs: add `description:` frontmatter to every page in the sidebar so `llms.txt` entries carry concrete one-line summaries. Docs-only; no package release needed.

Pages plugin: group `llms.txt` entries into H2 sections derived from the sidebar (Kernel Reference, Standard Library, SDK & Testing, …), use sidebar labels for link text, strip leading emoji from titles, and emit a new `llms-full.txt` with inlined page content (headings demoted and code fences preserved).
