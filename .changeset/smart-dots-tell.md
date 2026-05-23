---
---

Documentation restructure (breaking URL changes):

- Sidebar reorganized into five top-level groups: **Learn**, **Build**,
  **Reference** (Kernel + Standard Library), **Extend** (SDK), and **Examples**.
- Standard Library regrouped by domain (AI, HTTP & APIs, Storage & Data,
  Workflow & Control Flow, Encoding & Streams, Runtime Targets, Scripting,
  Configuration & Ops, Testing). Kernel reference split into Concepts,
  Capabilities, Topology, Modules & Imports, and Runtime & Ops sub-groups.
- New stub READMEs for previously unindexed modules: `assert`, `run`, `s3`,
  `test`, `codec`, `ndjson-codec`, `octet-codec`, `plain-text-codec`,
  `sse-codec`. Module READMEs standardized to a fixed five-section shape
  (purpose · why use this · kinds · example · reference).
- New auto-generated examples index at `/examples`, scanning
  `examples/*.yaml` and surfacing each manifest's `metadata.description`.
  Regenerated on every `docusaurus build`; `examples/INDEX.md` is gitignored.
- Doc URLs moved under new prefixes: `/learn/*`, `/build/*`,
  `/reference/kernel/*`, `/reference/std/*`, `/extend/sdk/*`, `/examples`.
  No redirects from the old `/standard-library/*`, `/kernel/*`, `/sdk/*`,
  `/getting-started`, `/cli` paths — anyone linking into the docs site
  should update.

No published-package code changes; this is a docs-site reshape.
