---
"@telorun/kernel": patch
"@telorun/sdk": patch
---

Fix `with:`-scoped resources in an imported library resolving their kinds against the **application's** import aliases.

A `Run.Sequence` declared in a library can open a scope over kinds the library imports:

```yaml
kind: Run.Sequence
metadata: { name: Authorize }
with:
  - kind: OAuth.RedirectListener   # `OAuth` is an alias of THIS library
    metadata: { name: SignInListener }
```

Phase-5 injection built the scope handle with `this.rootContext.createScopeHandle(...)` — the root context, unconditionally — so when the scope opened, its inline declarations resolved their kinds through the **root Application's** aliases. A library kind the app does not import failed with `Kind 'OAuth.RedirectListener': no module imported with alias 'OAuth'. Known aliases: Telo, SheetRows, Console, Run`, naming aliases from a file that never declared the resource. Only an app that happened to import the same modules under the same alias spellings worked.

The scope handle now hangs off the context that OWNS the resource, matching the rule the rest of the kernel already follows ("a controller's `ctx` is scoped to the context that owns its resource"). `PreInitHook` gains a fourth `owner: EvaluationContext` argument carrying it; a scope nested inside a scoped resource forwards its opening scope's context rather than replacing it, so kinds keep resolving through the declaring module at any depth.

`PreInitHook` is a kernel-internal contract — only the kernel installs one — so the added argument affects no module author.
