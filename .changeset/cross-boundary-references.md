---
"@telorun/kernel": minor
"@telorun/analyzer": minor
"@telorun/sdk": minor
"@telorun/http-server": minor
"@telorun/s3": minor
---

Resolve resource references uniformly across import boundaries and execution scopes.

- **http-server**: `mounts[].type` is now an injected `Telo.Mount` reference (`!ref <name>`, or `!ref <Alias>.<name>` for a mount exported by an imported library) instead of a dotted kind-string. The server consumes the live injected instance, so an `Http.Api` / `Mcp.HttpEndpoint` defined in another library can be mounted across the boundary. The bare `Kind.Name` string form is removed.
- **s3**: `bucketRef` is now an `x-telo-ref: "std/s3#Bucket"` slot (`!ref <bucket>` / `!ref <Alias>.<bucket>`); controllers consume the injected `S3.Bucket` instance, so S3 operations can reference a bucket exported by another library. The `{ name }` form is removed.
- **analyzer**: `resolveRefSentinels` recurses into `x-telo-scope` resources, so a `!ref` inside a scoped resource (e.g. a `Run.Sequence` `with:` server's mount) is canonicalized to `{kind, name}` like any top-level slot.
- **kernel**: Phase-5 dependency injection targets the (compile-CEL-expanded) resource the controller actually receives, so injected instances reach reference fields that also carry `x-telo-eval: compile` (e.g. `Http.Server.mounts`).
- **sdk**: `CreatedResource` gains an optional `resource`, letting a factory return the expanded manifest the controller was created with.
