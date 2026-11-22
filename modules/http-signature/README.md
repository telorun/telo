# HttpSignature

The grammar of signed HTTP requests, in one place so that whatever receives or sends them shares it: RFC 9421 message signatures, `Content-Digest` (RFC 9530) and the signed bytes of webhook schemes. It declares no kind and imports nothing: no transport, no verifier. A transport calls it with a plain request description and gets back the presentation a verifier checks.

| Name | What it is |
| --- | --- |
| `HttpSignature.BasePart` | A part of a webhook's signed bytes: `{ type: literal, value }`, `{ type: header, header, pattern? }` or `{ type: body }`. See [webhook signatures](./docs/webhook-signatures.md). |
| `@telorun/http-signature` | The code a transport reaches through `exports.code`. See [message signatures](./docs/message-signatures.md) and [the code API](./docs/code-api.md). |

Docs: [message signatures](./docs/message-signatures.md) · [webhook signatures](./docs/webhook-signatures.md) · [code API](./docs/code-api.md)
