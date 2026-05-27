// Shared umbrella version map — used by:
//   - scripts/npm-unpublish-1x.mjs   (folds stripped 1.x sections into ## <umbrella>)
//   - scripts/publish-umbrella.mjs   (writes umbrella versions, publishes them)
//
// Derived from each package's last-good <1.0 published version + a minor bump.
// Packages whose entire published history is 1.x (assert, test,
// workflow-temporal) get a starting 0.1.0. s3 had legitimate 1.x history but
// the user opted to wipe everything >= 1; treating it the same as the rest.
//
// Override here, in one place, if you want different targets per package.

export const UMBRELLA_TARGETS = {
  "@telorun/ai": "0.2.0",
  "@telorun/ai-openai": "0.2.0",
  "@telorun/analyzer": "0.12.0",
  "@telorun/assert": "0.1.0",
  "@telorun/benchmark": "0.3.0",
  "@telorun/cli": "0.13.0",
  "@telorun/codec": "0.3.0",
  "@telorun/config": "0.2.0",
  "@telorun/console": "0.6.0",
  "@telorun/http-client": "0.3.0",
  "@telorun/http-dispatch": "0.3.0",
  "@telorun/http-server": "0.5.0",
  "@telorun/javascript": "0.3.0",
  "@telorun/kernel": "0.13.0",
  "@telorun/lambda": "0.3.0",
  "@telorun/mcp-server": "0.5.0",
  "@telorun/ndjson-codec": "0.3.0",
  "@telorun/octet-codec": "0.3.0",
  "@telorun/plain-text-codec": "0.3.0",
  "@telorun/record-stream": "0.4.0",
  "@telorun/run": "0.3.0",
  "@telorun/s3": "0.1.0",
  "@telorun/sdk": "0.12.0",
  "@telorun/sql": "0.3.0",
  "@telorun/sse-codec": "0.3.0",
  "@telorun/starlark": "0.3.0",
  "@telorun/templating": "0.3.0",
  "@telorun/test": "0.1.0",
  "@telorun/type": "0.1.0",
  "@telorun/workflow-temporal": "0.1.0",
  "@telorun/yaml": "0.3.0",
};
