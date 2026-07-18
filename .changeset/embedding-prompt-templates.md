---
"@telorun/embedding": minor
"@telorun/embedding-openai": minor
"@telorun/kernel": minor
---

Add `queryPrompt` / `passagePrompt` to the `Embedding.Model` abstract.

Prompt-tuned retrieval checkpoints (embeddinggemma, E5, BGE) expect each text
wrapped in a fixed instruction that differs by retrieval intent. Feeding them
raw text does not fail — it collapses the similarity spread, so ranking
degenerates into noise. The templates are declared on the model, so the query
and passage sides cannot drift apart, and backends apply them through the
shared `applyEmbeddingPrompt` / `resolveEmbeddingPrompts` helpers. A template
missing the `{text}` placeholder is rejected at boot.

The kernel now stamps the inheritance-resolved author schema onto a definition
that `extends` another kind, reusing the analyzer's `effectiveAuthorSchema`.
Previously the analyzer accepted a field inherited from an `extends` parent
while the kernel — validating against the child's own schema only — rejected
the same resource at `create()`.
