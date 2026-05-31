// Shared umbrella version map — used by:
//   - scripts/npm-unpublish-1x.mjs   (folds stripped 1.x sections into ## <umbrella>)
//   - scripts/publish-umbrella.mjs   (writes umbrella versions, publishes them)
//
// Each target is one minor bump above the package's last legitimate pre-1.0
// published version on npm. Packages whose entire history is sub-1.0 still
// get an entry so the publish script bumps them off the bad 1.0.0 local
// state, even when there is nothing to unpublish.
//
// Override here, in one place, if you want different targets per package.

export const UMBRELLA_TARGETS = {
  "@telorun/ai": "0.3.0",
  "@telorun/ai-openai": "0.3.0",
  "@telorun/analyzer": "0.14.0",
  "@telorun/assert": "0.6.0",
  "@telorun/benchmark": "0.4.0",
  "@telorun/cli": "0.15.0",
  "@telorun/codec": "0.4.0",
  "@telorun/config": "0.3.0",
  "@telorun/console": "0.7.0",
  "@telorun/http-client": "0.4.0",
  "@telorun/http-dispatch": "0.4.0",
  "@telorun/http-server": "0.6.0",
  "@telorun/javascript": "0.4.0",
  "@telorun/kernel": "0.15.0",
  "@telorun/lambda": "0.4.0",
  "@telorun/mcp-client": "0.3.0",
  "@telorun/mcp-server": "0.6.0",
  "@telorun/ndjson-codec": "0.4.0",
  "@telorun/octet-codec": "0.4.0",
  "@telorun/plain-text-codec": "0.4.0",
  "@telorun/record-stream": "0.5.0",
  "@telorun/run": "0.4.0",
  "@telorun/s3": "0.2.0",
  "@telorun/sdk": "0.13.0",
  "@telorun/sql": "0.5.0",
  "@telorun/sse-codec": "0.4.0",
  "@telorun/starlark": "0.4.0",
  "@telorun/templating": "0.4.0",
  "@telorun/test": "0.4.0",
  "@telorun/type": "0.2.0",
  "@telorun/workflow-temporal": "0.2.0",
  "@telorun/yaml": "0.4.0",
};
