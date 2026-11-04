# SMS transports

`Sms.Transport` is the contract; `Sms.Capture` implements it here, and a provider
module implements it over the provider's API. Anything that sends
a text message — an application step, a library's flow — invokes a transport,
and a library takes one as a resource input typed by the abstract
(`resources: { sms: { kind: Sms.Transport } }`), so the importer decides which
transport delivers and a test hands it a capture.

## The contract

### Message

| Field | Shape | Meaning |
| --- | --- | --- |
| `to` | E.164 number | The recipient. Required. |
| `from` | E.164 number | The sender. Omitted, the transport's default sender. |
| `text` | string | The message text. Required and not empty. |

A number is written in E.164 form: `+`, the country code and the national number,
up to 15 digits with no spaces or punctuation (`+15551234567`, `+447700900123`).
Anything else is refused before any transport sees it: `telo check` reports a
literal one, and a computed one is `ERR_INPUT_INVALID` at the call. Turning a
number a person typed into E.164 is the caller's job, since it needs the
country the person meant.

The contract does not split or count segments: a long text is handed to the
provider as it is, and the provider decides how it is delivered and billed.

### Result

`{ messageId, status }`. `messageId` is the transport's id for the message,
which a provider's delivery reports name. `status` is `sent` when the message
has already left for the carrier and `queued` when the transport accepted it for
sending later; neither promises delivery to the handset.

### Errors

Every transport raises only these two codes (the abstract's `throws:` ceiling),
so a caller's `catches:` written against the contract covers any transport:

| Code | When | Retry? |
| --- | --- | --- |
| `ERR_SMS_REJECTED` | The provider refused the message, its sender, its recipient or the credentials. | The same message will be refused again. |
| `ERR_SMS_UNAVAILABLE` | The transport could not be reached, timed out, failed on its side, or refused temporarily (a rate limit). | May succeed later — a retry policy belongs here. |

The message of either error carries the provider's own explanation where there
is one.

## Capture in tests

`Sms.Capture` records each message it is handed, in order, and answers a fresh
`messageId` with status `sent`. It never refuses, so a test of an error path
uses a provider's transport against a stand-in server instead (as a
provider module's tests do). Messages are held in the process's
memory until the application stops, with no bound.

`Sms.CaptureRead` reads them back:

```yaml
kind: Sms.Capture
metadata: { name: sms }
---
kind: Sms.CaptureRead
metadata: { name: sentSms }
capture: !ref sms
```

Invoked with `{}` it returns `{ messages }`, oldest first, each message exactly
as it was sent plus its `messageId` — an omitted `from` stays omitted. With
`{ to: "+15551234567" }` it returns only the messages sent to that number; since
both are E.164, the comparison is exact.

A test hands the capture to the code under test where production hands it a
provider's transport, then asserts what was sent with `Assert.Equals`:

```yaml
- name: sent
  invoke: !ref sentSms
  inputs: { to: "+15551234567" }
- name: assertSent
  invoke: !ref Assert.equals
  inputs:
    actual: !cel "steps.sent.result.messages.map(m, m.text)"
    expected: [Your sign-in code is 123456.]
```
