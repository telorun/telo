# Mail transports

`Mail.Transport` is the contract; `Mail.Smtp` and `Mail.Capture` implement it.
Anything that sends email — an application step, a library's flow — invokes a
transport, and a library takes one as a resource input typed by the abstract
(`resources: { mail: { kind: Mail.Transport } }`), so the importer decides which
transport delivers and a test hands it a capture.

## The contract

### Message

| Field | Shape | Meaning |
| --- | --- | --- |
| `from` | address | The sender. Omitted, the transport's default sender. |
| `to` | address or list | Primary recipients. Required. |
| `cc`, `bcc` | address or list | Visible and hidden copies. |
| `replyTo` | address | Where replies go. |
| `subject` | string | Required. |
| `text`, `html` | string | The bodies; at least one is required, and both may be sent. |
| `headers` | map of string | Extra headers by name. |
| `attachments` | list | Each `{ filename, content, contentType? }`, `content` being bytes (`!include-bytes`, a step's bytes output, `bytes('…')`). Without `contentType` the media type is derived from the file name. |

An address is a string (`ada@example.com`, or `Ada <ada@example.com>`) or
`{ name, address }`. A message with neither `text` nor `html` is refused before
any transport sees it: `telo check` reports a literal one, and a computed one is
`ERR_INPUT_INVALID` at the call.

### Result

`{ messageId, accepted, rejected }`. `accepted` and `rejected` hold bare email
addresses. A transport that accepted the message for some recipients and refused
others returns normally with the refused ones in `rejected`; only a message
refused for every recipient is an error.

### Errors

Every transport raises only these two codes (the abstract's `throws:` ceiling),
so a caller's `catches:` written against the contract covers any transport:

| Code | When | Retry? |
| --- | --- | --- |
| `ERR_MAIL_REJECTED` | The server or provider refused the message, its sender, its credentials, or every recipient. | The same message will be refused again. |
| `ERR_MAIL_UNAVAILABLE` | The transport could not be reached, timed out, failed on its side, or refused temporarily. | May succeed later — a retry policy belongs here. |

The message of either error carries the server's own reply where there is one.

## SMTP

`Mail.Smtp` keeps a pool of connections to one server, created when the resource
starts and closed when it stops.

| Field | Default | Meaning |
| --- | --- | --- |
| `host` | — | Server host name or address. Required. |
| `port` | 465 with `secure`, else 587 | Server port. |
| `secure` | `false` | TLS from the first byte (implicit TLS, usually port 465). |
| `starttls` | `require` | For a plain connection: `require` fails unless the server offers STARTTLS (so credentials are never sent in clear), `opportunistic` upgrades when offered, `never` stays plain. Not used when `secure`. |
| `auth` | none | `{ user, pass }`; take `pass` from `secrets:`. |
| `from` | — | The default sender, used for every message naming none. Required. |
| `pool.maxConnections` | `5` | Connections open at once. |
| `pool.maxMessages` | `100` | Messages per connection before it is replaced. |
| `timeout` | `30s` | Limit for connecting, the greeting and each reply. Must be longer than zero. |

A message never makes the transport read a local file or fetch a URL: attachment
content is always the bytes handed over.

**How a failure is classified.** A reply in the 4xx range, or 503, is temporary
and is `ERR_MAIL_UNAVAILABLE`; any other 5xx reply is `ERR_MAIL_REJECTED`. With no
reply code, a refused envelope, message or sign-in (bad or missing credentials,
too many recipients) is `ERR_MAIL_REJECTED`, and everything else — a refused or
dropped connection, DNS, TLS, a timeout — is `ERR_MAIL_UNAVAILABLE`.

## Capture in tests

`Mail.Capture` records each message it is handed, in order, and answers a fresh
`messageId` with every `to`, `cc` and `bcc` address accepted. It never refuses,
so a test of an error path uses `Mail.Smtp` against a real server instead
(`tests/integration/smtp.yaml` does this with Mailpit). Messages are held in the
process's memory until the application stops.

`Mail.CaptureRead` reads them back:

```yaml
kind: Mail.Capture
metadata: { name: mail }
---
kind: Mail.CaptureRead
metadata: { name: sentMail }
capture: !ref mail
```

Invoked with `{}` it returns `{ messages }`, oldest first, each message exactly as
it was sent plus its `messageId` — addresses are not rewritten, and an omitted
field stays omitted. With `{ to: ada@example.com }` it returns only the messages
having that address among their `to` recipients (a `cc` or `bcc` address does
not match), compared case-insensitively and matching either address form.

A test hands the capture to the code under test where production hands it an
SMTP transport, then asserts what was sent with `Assert.Equals`:

```yaml
- name: sent
  invoke: !ref sentMail
  inputs: { to: ada@example.com }
- name: assertSent
  invoke: !ref Assert.equals
  inputs:
    actual: !cel "steps.sent.result.messages.map(m, m.subject)"
    expected: [Welcome]
```

`Assert.Equals` compares bytes by identity, so compare an attachment's content
through CEL (`string(m.attachments[0].content)`) rather than against a
`bytes('…')` literal.
