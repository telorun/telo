---
"@telorun/http-server": patch
---

Tighten `Http.Api.routes[].request.headers` to declare `additionalProperties: { type: "string" }`. Header values are matched as strings against the incoming request, so the schema now reflects what the runtime actually accepts. The telo editor renders this field as a key/value map editor instead of the JSON Schema designer.
