---
"@telorun/analyzer": patch
---

Validate inline resources nested inside resource bodies. Inline resources sitting at `x-telo-ref` slots reached only through a local `$ref` (notably `Run.Sequence`'s `steps[].invoke`) were never analyzed, so a manifest like `invoke: { kind: Console.ReadLine, prompt: "…" }` — where `prompt` belongs in the step's `inputs` — passed analysis but failed at runtime. The analyzer now walks each resource against its definition schema and, at those reference slots, validates each inline resource's config against its own kind's schema and reports an unknown inline kind (`UNDEFINED_KIND`) — neither of which any field-map-driven pass could see.
