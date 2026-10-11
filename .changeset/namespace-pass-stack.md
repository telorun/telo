---
"@telorun/cel": patch
---

The namespace pass no longer overflows the stack on the tallest tree a read can leave. Resolving `Alias.fn(x)` calls over an expression nested to the parser's limit (1,750 levels once the refused node's brackets close) needed about 850 KB of stack, which a default Node stack does not always have; it now needs about 490 KB, less than writing the same tree back as source does. The resolved tree is unchanged.
