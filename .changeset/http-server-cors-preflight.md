---
"@telorun/http-server": patch
---

Fix CORS preflight returning 404. `Http.Server` forwarded every `cors` option to `@fastify/cors`, including the ones the manifest left unset — spreading `preflight: undefined` (and friends) clobbered the plugin's own default `preflight: true`, so its `OPTIONS *` handler `callNotFound()`'d and the preflight came back 404. Browsers reject that ("Response to preflight request … does not have HTTP ok status") and block every cross-origin `POST`. Now only the fields actually set on `cors` are passed through, so unset options keep the plugin's defaults and preflight replies 204.
