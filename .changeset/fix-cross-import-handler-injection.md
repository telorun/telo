---
"@telorun/kernel": patch
"@telorun/sdk": patch
---

Fix `ERR_RESOURCE_NOT_INVOKABLE` when mounting an imported library's `Http.Api` whose route handler is a library-internal resource.

Phase-5 dependency injection now defers a resource whose **local** (`!ref name`) reference points at another resource that is registered in the same context but not yet initialized, mirroring the existing cross-module (`!ref Alias.name`) deferral. Previously such a local ref was silently left unresolved when create-success order diverged from init order — e.g. an importer that preloads the `Http.Api` controller lets the API create and inject before its internal handler's controller has loaded — leaving the handler slot as a raw `{kind, name}` sentinel that failed at request time. `PreInitHook` gains an `isPending` predicate so the injection walk can tell a pending dependency apart from a genuinely absent reference.
