---
"@telorun/ai": patch
"@telorun/ai-openai": patch
"@telorun/analyzer": patch
"@telorun/assert": patch
"@telorun/benchmark": patch
"@telorun/codec": patch
"@telorun/config": patch
"@telorun/console": patch
"@telorun/http-client": patch
"@telorun/http-dispatch": patch
"@telorun/http-server": patch
"@telorun/javascript": patch
"@telorun/kernel": patch
"@telorun/lambda": patch
"@telorun/mcp-client": patch
"@telorun/mcp-server": patch
"@telorun/ndjson-codec": patch
"@telorun/octet-codec": patch
"@telorun/plain-text-codec": patch
"@telorun/record-stream": patch
"@telorun/run": patch
"@telorun/s3": patch
"@telorun/sql": patch
"@telorun/sse-codec": patch
"@telorun/starlark": patch
"@telorun/templating": patch
"@telorun/test": patch
"@telorun/type": patch
"@telorun/workflow-temporal": patch
"@telorun/yaml": patch
---

Loosen the `@telorun/sdk` peer dependency range from an exact pin to `*`.

The sdk is a host-provided peer (the kernel supplies the single shared instance, so `Stream` and other sdk class identities stay intact for CEL's runtime type-checker). Pinning it via `workspace:*` published as an exact version, which made every sdk release fall out of range and forced a spurious major bump of all peer-dependents. Declaring the peer range as `*` (with a `workspace:*` devDependency to preserve local linking) keeps the single-instance guarantee while preventing the false major-bump cascade.
