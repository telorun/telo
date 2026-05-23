# Mirror Node.js SDK Documentation in Rust SDK

## Problem

The Rust SDK README is shaped around its PoC status (author principle, backends, layout) and does not cover the contracts a controller author needs to reason about — most importantly the Telo error model (`InvokeError` vs operational failures, `throws:` declaration, `inherit` / `passthrough` composers) that the Node.js SDK README documents. The Rust SDK is also missing from the docs site: [pages/sidebars.ts](../../../pages/sidebars.ts) lists only Node.js under the SDK category, and [sdk/README.md](../../README.md) only links to the Node.js SDK. Rust controller authors today have no canonical place to learn what guarantees they're writing against.

## Solution

Rewrite [sdk/rust/README.md](../README.md) so it follows the Node.js SDK README's section order and covers the same contracts, with idiomatic Rust framing throughout. No `docs/` folder is introduced — the Rust SDK stays single-file, matching Node.js.

Section parity with [sdk/nodejs/README.md](../../nodejs/README.md):

1. **What It Provides** — controller trait surface, ResourceContext, DataValidator.
2. **When to Use It** — building Rust controllers loaded by the Node.js kernel today, future pure-Rust kernel later.
3. **Errors** — port the Node.js error contract: distinguish operational failures (plain errors / `ControllerError`) from domain failures (the planned Rust equivalent of `InvokeError`), the `throws.codes:` manifest declaration, and the `inherit` / `passthrough` composer modes. Where the Rust surface doesn't yet expose a piece (notably a structured-error type analogous to `InvokeError`), the section documents the intended contract — the same one the Node.js SDK enforces — so authors target the right shape from day one and the Rust runtime catches up against a written spec.
4. **Related Docs** — cross-links to kernel overview, standard library, SDK index, and the Node.js SDK README for the canonical TS implementation.

The existing PoC-specific content (status note, backends, forward-compatibility, layout) is preserved and folded into the new structure: the PoC status note moves to the top of "What It Provides"; backends and forward-compatibility merge into "When to Use It"; the layout block stays at the end as an appendix-style section after "Related Docs".

Docs-site wiring:

- Add a "Rust" sub-category under the existing SDK category in [pages/sidebars.ts](../../../pages/sidebars.ts), mirroring the Node.js sub-category shape (`sdk/rust/README` as Overview).
- Add a Rust bullet to [sdk/README.md](../../README.md) alongside the Node.js bullet.
- No `docusaurus.config.ts` change needed — `docInclude` is derived from sidebar ids.

Changeset: one entry under `.changeset/` covering `@telorun/sdk` (Node.js) is unaffected; the Rust crate is not published via changesets today, so the changeset is doc-only / empty per the `changeset add --empty` convention.

## Decisions

- **Mirror by section parity, not by copy** — sections match the Node.js README one-for-one, but prose is rewritten in Rust terms (traits, `Result`, `serde_json::Value`) rather than ported verbatim. Rationale: keeps each SDK's examples idiomatic; rejected verbatim copy because TS-flavored snippets would mislead Rust authors.
- **Document the intended error contract, not just what exists** — the Errors section describes the full `InvokeError`-equivalent shape even though the Rust SDK doesn't expose it yet. Rationale: gives Rust authors and future implementers a single written target; rejected "document only current surface" because it would leave a contract gap between SDKs and let early Rust controllers drift away from the kernel's model.
- **Single README, no `docs/` folder** — matches Node.js layout exactly. Rationale: avoids premature structure for content that fits one page; a folder can be introduced later if the SDK grows enough to warrant it.
- **Preserve PoC-specific content in-place** — backends, layout, status note are kept and merged into the new sections rather than dropped. Rationale: that information is still accurate and useful; mirroring structure does not mean discarding Rust-specific facts.
