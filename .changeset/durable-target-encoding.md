---
"@telorun/sdk": minor
"@telorun/kernel": minor
---

Durable step targets can now cross a process boundary. `encodeDurableTarget` / `decodeDurableTarget` fix the wire form of a step's declaration-site identity — JSON with a canonical key order and a version, so two runtimes producing the same identity produce the same bytes and a reader receiving an unknown version refuses it rather than reading the fields it recognises. An identity too incomplete to resolve elsewhere is refused at the SENDER, where the manifest that produced it is still in reach.

For that to be worth anything the identity has to be derived, and a step's `invoke:` slot is not a Phase-5 injection site — it resolves at dispatch — so a step target arrives carrying no stamp of its own. The kernel now stamps the declaration site at `create()`, its single instance-production site and the one point where an instance and the context that DECLARED it are both in hand (at injection the context is the consumer's), and the step leaf recovers it by resolving the reference the same way the dispatch does.

A `with:`-scoped target is refused rather than encoded: `DurableTarget.scoped` records that a name resolved inside a scope, which the step engine knows because the resolution is what answered it, separately from the tuple identifying which scope RUN, which needs a step path a scope handle is built without. Without that flag such a target is indistinguishable from a module-level one and would ship — and resolve, at the far end, to a different resource that merely shares the name.

`DurableRunHandle.noteCollapsed` is replaced by `noteZoneMode`, which reports every atomic or idempotent region and how it resolved — `collapsed` or `perStep` — rather than only the collapsed ones. `perStep` is the exactly-once regime and is reached by a runtime attestation, so the affirmative answer is the one an operator most needs.
