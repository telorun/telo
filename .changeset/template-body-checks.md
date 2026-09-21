---
"@telorun/analyzer": minor
---

Check a template body's entries the way the kernel creates them

An inline declaration inside a template body entry — a route's `handler: { kind: Run.Sequence, … }` — is now extracted into an entry of its own, so it is created with the rest of the body instead of failing at request time as not invocable, and its CEL is typed by its own kind. `telo check` also validates each entry against its kind's schema (`SCHEMA_VIOLATION`), resolves a step's `invoke: !ref` inside an entry (`TEMPLATE_REF_UNKNOWN`) and refuses two entries under one name (`DUPLICATE_RESOURCE_NAME`) — each already a boot-time failure. A diagnostic inside an extracted declaration is anchored at the position the author wrote and never names the generated entry.

A CEL diagnostic's message no longer quotes its own position: `Kind/name: !cel at 'path': …` is now `Kind/name: !cel: …`, and `CEL syntax error at path: …` is `CEL syntax error: …`. The position is where every host already anchors the diagnostic (`data.path`, file:line:col in `telo check`).
