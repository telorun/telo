# HTTP SMS providers

`SmsTwilio.Transport` is the pattern for an SMS provider reached over HTTP: one
templated kind extending `Sms.Transport`, with no controller. Its whole
behaviour — the request, the error mapping, the result — is in `telo.yaml`.

## How a message reaches Twilio

The message is posted to
`<baseUrl>/2010-04-01/Accounts/<accountSid>/Messages.json` as a form body
(`application/x-www-form-urlencoded`), with the account SID and the auth token
as HTTP Basic credentials.

| Message | Twilio | How |
| --- | --- | --- |
| `to` | `To` | As given. |
| `from` | `From` | The message's own, else the transport's `from`. |
| `text` | `Body` | As given. |

Every value is form-encoded, so `+15551234567` travels as `%2B15551234567`.

## Outcomes

| Twilio answers | Result |
| --- | --- |
| 2xx with a `sid`, status `sent` or `delivered` | `{ messageId: <sid>, status: sent }` |
| 2xx with a `sid`, any other status (`queued`, `accepted`, `scheduled`, …) | `{ messageId: <sid>, status: queued }` |
| 2xx without a `sid` | `ERR_SMS_UNAVAILABLE` — but see the duplicate-send caveat below |
| 408, 429 | `ERR_SMS_UNAVAILABLE` — a timeout or a rate limit, worth retrying |
| any other 4xx | `ERR_SMS_REJECTED` — bad credentials, an invalid number, a sender the account does not own |
| 5xx, anything else | `ERR_SMS_UNAVAILABLE` |
| no answer (DNS, refused connection, timeout) | `ERR_SMS_UNAVAILABLE` |

**Duplicate-send caveat.** A 2xx answer means Twilio may already have accepted
the message even though no SID came back; the error says so. It is
`ERR_SMS_UNAVAILABLE`, so a retry policy that retries unavailability can send
the message twice. Retry it only when a duplicate is acceptable, or de-duplicate
on your side.

The message of either error is
`Twilio refused the message with HTTP <status>: <code>: <message>` or
`Twilio answered HTTP <status>: <code>: <message>`, from Twilio's error body
`{ code, message, more_info, status }`; a part Twilio leaves out is left out.

## Writing another provider

A provider such as Vonage or MessageBird follows the same shape, in its own module importing `sms` and
`http-client`. `mail-resend`'s `docs/providers.md` describes the same pattern
for email.

1. **A `Telo.Definition` extending `Sms.Transport`**, with no `controllers:`.
   It inherits the message contract, the result contract and the `throws:`
   ceiling, so it raises only `ERR_SMS_REJECTED` and `ERR_SMS_UNAVAILABLE`. Its
   `schema` holds the provider's settings — the credentials, a required
   default `from`, and a `baseUrl` with the provider's address as its default,
   which a test points at a stand-in. Mark each `x-telo-eval: compile` so a
   consumer can write `!cel "secrets.…"`.
2. **An `Http.Request` entry** over an inline `Http.Client` whose `baseUrl` is
   `self.baseUrl` and whose `credential` is the provider's scheme
   (`Http.BasicAuth`, `Http.BearerToken`, `Http.ApiKeyHeader`), with the path,
   the method and — for a form body — the `content-type` header baked into its
   `inputs`. An object body is form-encoded only when that header says so.
   Leave `throwOnHttpError` off, so every status comes back to be classified.
3. **A `Telo.Sequence` entry the kind's `invoke:` names.** Its steps:
   - the request inside a `try:` whose `catch:` raises `ERR_SMS_UNAVAILABLE`,
     so a failure with no answer stays within the ceiling;
   - a `switch` on the status: a success falls through, a refusal of the
     message raises `ERR_SMS_REJECTED`, and a temporary refusal or a failure on
     the provider's side raises `ERR_SMS_UNAVAILABLE`, each message carrying the
     provider's own explanation from its error body;
   - `outputs:` with the provider's id and its status, since the kind's
     `result:` sees only the sequence's output.
4. **Top-level `inputs:`** mapping the message onto the provider's request body
   — the field names it expects, the sender defaulted from `self.from`.
5. **Top-level `result:`** mapping the sequence's output onto
   `{ messageId, status }`, reducing the provider's statuses to `sent` and
   `queued`.

Test it as `tests/send.yaml` does: an `Http.Server` in the test sequence's
`with:` stands in for the provider and answers with an id that echoes the path,
the `authorization` header and the raw body it received (a form body arrives as
text through a `contentTypeParsers` entry with no parser), so one
`Assert.Equals` pins the request exactly; further routes answer the statuses to
map and the error statuses, and a `baseUrl` nothing listens on covers the
unreachable case.
