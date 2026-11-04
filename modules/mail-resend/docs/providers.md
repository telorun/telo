# HTTP mail providers

`MailResend.Transport` is the pattern for a mail provider reached over HTTP: one
templated kind extending `Mail.Transport`, with no controller. Its whole
behaviour — the request, the error mapping, the result — is in `telo.yaml`.

## How a message reaches Resend

The message is posted as JSON to `<baseUrl>/emails`, with the API key as
`Authorization: Bearer <apiKey>`.

| Message | Resend | How |
| --- | --- | --- |
| `from` | `from` | The message's own, else the transport's `from`. |
| `to`, `cc`, `bcc` | `to`, `cc`, `bcc` | Always a list, even for one address. |
| `replyTo` | `reply_to` | One address. |
| `subject`, `text`, `html` | same | As given; an omitted body is left out. |
| `headers` | `headers` | As given. |
| `attachments` | `attachments` | Each `{ filename, content, content_type }`, `content` base64-encoded. |

An address string is sent as written. `{ name, address }` becomes
`Name <address>`, and a name holding a character that would split it (a comma, a
quote, `<`, `@`, …) is quoted, with `"` and `\` escaped: `{ name: 'Doe, Jane',
address: jane@example.com }` is sent as `"Doe, Jane" <jane@example.com>`. An
empty name sends the address alone.

## Outcomes

| Resend answers | Result |
| --- | --- |
| 2xx with an `id` | `{ messageId: <id>, accepted: <every to, cc and bcc address>, rejected: [] }` |
| 2xx without an `id` | `ERR_MAIL_UNAVAILABLE` — but see the duplicate-send caveat below |
| 408, 429 | `ERR_MAIL_UNAVAILABLE` — a timeout or a rate limit, worth retrying |
| any other 4xx | `ERR_MAIL_REJECTED` — a bad key, an unverified domain, an invalid message |
| 5xx, anything else | `ERR_MAIL_UNAVAILABLE` |
| no answer (DNS, refused connection, timeout) | `ERR_MAIL_UNAVAILABLE` |

`accepted` holds bare addresses: an object's `address`, or the `<…>` part of a
string written `Name <address>`. Resend reports no per-recipient refusal, so
`rejected` is always empty.

**Duplicate-send caveat.** A 2xx answer means Resend may already have accepted
the message even though no id came back; the error says so. It is
`ERR_MAIL_UNAVAILABLE`, so a retry policy that retries unavailability can send
the message twice. Retry it only when a duplicate is acceptable, or de-duplicate
on your side.

The message of either error is
`Resend refused the message with HTTP <status>: <name>: <message>` or
`Resend answered HTTP <status>: <name>: <message>`, from Resend's error body
`{ statusCode, name, message }`.

## Writing another provider

A provider such as SendGrid, Postmark or Mailgun follows the same shape, in its
own module importing `mail` and `http-client`:

1. **A `Telo.Definition` extending `Mail.Transport`**, with no `controllers:`.
   It inherits the message contract, the result contract and the `throws:`
   ceiling, so it raises only `ERR_MAIL_REJECTED` and `ERR_MAIL_UNAVAILABLE`.
   Its `schema` holds the provider's settings — the credential, a required
   default `from`, and a `baseUrl` with the provider's address as its default,
   which a test points at a stand-in. Mark each `x-telo-eval: compile` so a
   consumer can write `!cel "secrets.…"`.
2. **An `Http.Request` entry** over an inline `Http.Client` whose `baseUrl` is
   `self.baseUrl` and whose `credential` is the provider's scheme
   (`Http.BearerToken`, `Http.ApiKeyHeader`, `Http.BasicAuth`), with the path and
   method baked into its `inputs`. Leave `throwOnHttpError` off, so every status
   comes back to be classified.
3. **A `Telo.Sequence` entry the kind's `invoke:` names.** Its steps:
   - the request inside a `try:` whose `catch:` raises `ERR_MAIL_UNAVAILABLE`,
     so a failure with no answer stays within the ceiling;
   - a `switch` on the status: a success falls through, a refusal of the
     message raises `ERR_MAIL_REJECTED`, and a temporary refusal or a failure on
     the provider's side raises `ERR_MAIL_UNAVAILABLE`, each message carrying
     the provider's own explanation from its error body;
   - `outputs:` with the provider's id and the recipients.
4. **Top-level `inputs:`** mapping the message onto the provider's request body
   — the field names it expects, addresses as it takes them, attachment bytes
   through `bytesToBase64` — and the bare recipient addresses for the result.
   Module-local `Telo.Function`s (`Self.mailbox`, `Self.mailboxes`) keep an
   address rule written once.
5. **Top-level `result:`** mapping the sequence's output onto
   `{ messageId, accepted, rejected }`. A provider that reports refused
   recipients one by one puts them in `rejected` instead of failing.

Test it as `tests/send.yaml` does: an `Http.Server` in the test sequence's
`with:` stands in for the provider and answers with an id that echoes the
`authorization` header and the body it received, so one `Assert.Equals` pins the
request exactly; further routes answer the error statuses, and a `baseUrl`
nothing listens on covers the unreachable case.
