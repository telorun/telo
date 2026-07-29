---
"@telorun/kernel": minor
"@telorun/run": minor
---

Fix a `with:`-scoped resource that shares a name with a module-level one.

Three defects, all reachable together and none of them loud:

- **Phase 5 injected the shadowed outer instance.** The scope child's injection
  hook fell through to the enclosing module whenever a scope-local resource of the
  same name was merely not initialized yet, so which instance a `!ref` bound
  depended on the scope's init order. A name the scope declares now resolves to the
  scope's instance or defers as pending — never to the resource it shadows.

- **`Run.Sequence` rejected an injected scope target.** `scopeTargetName` read only
  `{name}` and `!ref` sentinels. When a module-level resource shares the scoped
  name the entry *is* injected as a live instance, which it treated as an
  unrecognized shape. It now recovers the name from the identity the kernel stamps
  at injection.

- **The error path crashed on the error value.** That same rejection built its
  message with `JSON.stringify(target)`, and a live instance holds sockets and
  parent back-references — so the failure surfaced as `cannot serialize cyclic
  structures` from inside the error handler, burying what actually went wrong. It
  now describes the value structurally without walking it.
