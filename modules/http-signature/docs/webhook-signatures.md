# Webhook signatures

Most webhook providers sign `<timestamp><separator><body>`, or the body alone, with a shared secret and send the signature, and sometimes the timestamp, in headers. One reader covers them all, configured with data.

## Options

- `signature: { header, pattern?, encoding }` — the header carrying the signature. `pattern` is an RE2 pattern (`format: re2-pattern`) whose first group is taken, every match in the header, so several signatures (a rotating secret) are all presented; without one the whole header is the signature. `encoding` is `hex`, `base64` or `base64url`.
- `timestamp: { header, pattern?, unit }` — optional; `unit` is `seconds` or `milliseconds`. A reader that declares it treats a missing or unreadable timestamp as malformed; one that does not yields a presentation with no `created`.
- `base` — an ordered list of `HttpSignature.BasePart`, joined with nothing between them.

## `HttpSignature.BasePart`

| Part | Contributes |
| --- | --- |
| `{ type: literal, value }` | The text, as written. |
| `{ type: header, header, pattern? }` | The header's value; with `pattern`, the first group of its first match. A missing header, or a pattern that matches nothing, is malformed. |
| `{ type: body }` | The raw request body bytes. |

A signature header that is absent carries no credential; one that is present and yields no signature, or one that does not decode in its encoding, is malformed.

The vendor shapes (Stripe, GitHub, Slack, Shopify, Standard Webhooks) are data for these options; see the [`auth-signature` recipes](https://hub.telo.run/module/oci/ghcr.io/telorun/auth-signature/).
