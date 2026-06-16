---
"@telorun/http-server": patch
---

http-server: a route handler now receives its resolved `inputs` once. Previously the dispatch passed `{ ...resolvedInputs, inputs: resolvedInputs }` — the resolved fields plus a second nested copy under `inputs` that nothing read (a templated handler's `${{ inputs.X }}` already resolves against the top-level fields). The redundant copy is gone, so the handler argument — and the debug trace's invocation inputs — show each value a single time. No reader relied on the nested key, so this is behaviour-preserving for handlers.
