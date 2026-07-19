---
"@telorun/sdk": minor
"@telorun/kernel": minor
"@telorun/http-client": minor
"@telorun/mcp-client": minor
"@telorun/embedding-openai": minor
"@telorun/ai-openai": minor
"@telorun/lambda": minor
---

Make network failures actionable instead of `fetch failed`.

`fetch` rejects with an opaque `TypeError: fetch failed` for DNS, connection
refusal, and TLS alike; the real cause (`ENOTFOUND`, `ECONNREFUSED`, …) sits on
`error.cause`, which nothing in the repo read. A misconfigured host surfaced as
`INTERNAL_ERROR: fetch failed` with nothing to act on — no host, no reason, no
indication of which manifest field was wrong.

`fetchOrThrow` in `@telorun/sdk` wraps a transport failure as an `InvokeError`
with code `ERR_NETWORK_UNREACHABLE`, carrying structured `data` — `operation`,
`url`, `host`, `port`, `cause`, the underlying `detail`, and the `resource` +
`setting` to change — plus a default message composed from them. A non-OK
response is returned untouched — a status code is a reply the caller interprets,
often from the provider's own error body — so it drops into existing call sites
without changing status handling. Cancellation is re-thrown as-is.

Every part is structured, including the actionable one: a call site passes
`resource` (the instance's `metadata.name`) and `setting` (`baseUrl`) as bare
identifiers, and the sentence is composed in one place. Prose at the call site
would be exactly what another language's SDK has to retype and keep in sync,
whereas `cause: "ENOTFOUND"` and `setting: "baseUrl"` are the same symbols
everywhere — so a kernel-side renderer can later format from `data` without any
SDK changing.

Wrapping never loses what was thrown: the original error is preserved as
`cause` (`InvokeError` gained an optional `{ cause }`), its message is kept in
`data.detail`, and for a code the mapping does not recognise that message is
appended to the rendered text — so an unmapped code reads as strictly more than
the raw `fetch failed` it replaces, never less.

Also fixes a live misclassification in `Http.Request`: `mapNetworkError`
selected its error kind by substring-matching the message, but the message is
always the literal `"fetch failed"`, so `enotfound`/`ssl` never matched and every
network failure — DNS and TLS included — was reported as `CONNECTION_REFUSED`.
It now classifies on the cause chain's code, via the exported `networkCauseCode`.
`Mcp.Client` had the same opaque-message problem in its transport error and is
fixed the same way.
