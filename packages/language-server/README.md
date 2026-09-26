# @telorun/language-server

The telo language-server engine: every Telo diagnostic and editor feature of one
telo version, as a single self-contained ES module (`dist/language-server.mjs`,
no imports) that speaks LSP over a message port. `@telorun/language-server@X`
is telo `X`'s engine.

```js
import { serve } from "@telorun/language-server";
serve(self); // inside a Web Worker; any { postMessage, addEventListener("message") } port works
```

The engine does no I/O of its own — every file, import and hub answer is a
`telo/*` request its host serves. The protocol, the handshake and the host's
obligations are specified in
[`@telorun/editor-protocol`](../editor-protocol/README.md).
