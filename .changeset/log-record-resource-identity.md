---
"@telorun/kernel": patch
---

Controller log records carry their resource identity again, and a detached task failure is no longer invisible.

`ResourceContextImpl.log` built the record's `resource` field by reading `metadata.kind` and `metadata.metadata.name`. But `metadata` is the resource's metadata **block** — `kind` is its sibling, not its member, and there is no nested `metadata` — so both reads were `undefined` and the field was dropped from every record a controller emitted. The identity now comes from the resolved kind, which is the canonical `<module>.<Kind>` produced by `resolveKind()`, so the recorded kind is independent of whatever alias the importer chose.

The kind is passed to the context at construction rather than at `bindResourceIdentity`, which runs after `create()` returns. A controller that captures `ctx.log` in its constructor — the natural thing to do when the logger is handed to a helper that outlives the call — would otherwise hold an identity-less logger for the resource's whole life, and nothing would report that it had.

`ctx.runDetached` routed a failure to the event bus alone. The bus short-circuits to zero cost with no subscriber, so in any run without a debug consumer attached a detached task could fail with nothing reported anywhere — it has no caller to throw to. The failure is now also logged at `error`, and `drainDetached` warns when it abandons tasks at the drain timeout, which its own comment already claimed it did.
