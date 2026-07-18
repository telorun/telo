---
"@telorun/kernel": minor
"@telorun/sdk": minor
"@telorun/ai": patch
"@telorun/ai-mcp": patch
"@telorun/ai-openai": patch
"@telorun/assert": patch
"@telorun/benchmark": patch
"@telorun/gzip": patch
"@telorun/image": patch
"@telorun/ndjson-codec": patch
"@telorun/octet-codec": patch
"@telorun/pdf": patch
"@telorun/plain-text-codec": patch
"@telorun/s3": patch
"@telorun/sse-codec": patch
"@telorun/stream": patch
"@telorun/tar": patch
"@telorun/test": patch
"@telorun/yaml": patch
---

The `Telo.Definition` schema is now the sole resource-config contract.

A controller module's exports become the controller instance verbatim, so an
`export const schema` silently won over the manifest's `schema:`. The analyzer
never loads controllers, so those overrides were invisible to `telo check` and
to the editor, could not be pre-compiled by the validator warm (recompiling on
every boot, and failing to persist on a read-only image), and were free to drift
from the manifest they shadowed.

`ControllerInstance.schema` is removed, and the kernel now validates every
resource against its definition's schema. All 35 controller-exported schemas are
gone: 26 were `additionalProperties: true` catch-alls that merely *disabled* the
manifest's stricter validation, and 9 kept their TypeBox for `Static<typeof …>`
typing but no longer export it.

Two manifests had already drifted and are corrected:

- `S3.Bucket` was missing `accessKeyId` / `secretAccessKey` entirely, though its
  controller required both. They are now declared (and required) in the manifest.
- `Assert.ModuleContext` was missing `resources` / `variables` / `secrets`.

Controller authors: declare config in `telo.yaml`, not in code. An
`export const schema` is now inert.
