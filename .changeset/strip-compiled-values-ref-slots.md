---
"@telorun/kernel": patch
---

Fix `Maximum call stack size exceeded` when a template passes its caller's resource down to a child.

A `Telo.Definition` whose `resources:` body forwards a ref slot through CEL — `client: !cel "self.client"` — hands the child the **live instance** Phase-5 injection put on the parent, by design (`resource-template-controller` resolves a pure `self.<path>` by navigating the resource rather than through CEL, which rejects live instances). The child's manifest therefore reaches schema validation with a controller's object graph sitting in its `client` slot, and `stripCompiledValues` walked it with no guard. A client whose graph points back at itself overflowed the stack, and the overflow surfaced as `Resource does not match schema for kind Http.Request: Maximum call stack size exceeded [ERR_RESOURCE_SCHEMA_VALIDATION_FAILED]` — a `RangeError` wearing a schema violation's clothes, pointing at a manifest with nothing wrong in it.

The walk now stops where `buildResolvedProperties` already stopped:

- a slot the schema declares with `x-telo-ref` is returned as-is — it holds a `{kind, name}` ref or the instance that replaced it, and the schema declares no shape for either;
- a class instance is returned as-is — it carries no compiled values and copying it is pure risk;
- a genuine cycle (ancestor-scoped, so a sub-object that merely appears twice still strips at both sites) is returned as-is instead of recursed into.

Affects any templated kind forwarding a reference, including the `std/crud` kinds and Google Sheets' `GetSpreadsheet` / `GetValues`.
