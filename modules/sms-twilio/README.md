# SmsTwilio

`sms-twilio` — sending text messages through the
[Twilio](https://www.twilio.com) Messaging API behind the `Sms.Transport`
contract, so an application or library written against `sms` switches to
Twilio by declaring this transport instead of another.

## Kinds

| Kind | Purpose |
| --- | --- |
| `SmsTwilio.Transport` | Send one text message through Twilio's `POST …/Messages.json`. |

`SmsTwilio.Transport` extends `Sms.Transport`: it takes the contract's message
and answers `{ messageId, status }` with Twilio's message SID, `status` being
`sent` when Twilio reports the message `sent` or `delivered` and `queued` for
any other status it accepts. Config:

| Field | Default | Meaning |
| --- | --- | --- |
| `accountSid` | — | The account SID (`AC` and 32 hex digits): the Basic username and part of the request path. Required. |
| `authToken` | — | The account's auth token, the Basic password. Required; take it from `secrets:`. |
| `from` | — | The sender of every message naming none, a Twilio number of the account in E.164 form. Required. |
| `baseUrl` | `https://api.twilio.com` | Where the API is reached, without a trailing slash. |

A 4xx answer other than 408 and 429 is `ERR_SMS_REJECTED`; 408, 429, any other
answer that is not a 2xx, a 2xx without a message SID, and a request that never
got an answer are `ERR_SMS_UNAVAILABLE`. The error message carries Twilio's own
error code and explanation.

## Example

```yaml
kind: Telo.Application
metadata: { name: SignIn, version: 1.0.0 }
imports:
  SmsTwilio: oci://ghcr.io/telorun/sms-twilio@<version>
secrets:
  twilioAccountSid: { env: TWILIO_ACCOUNT_SID, type: string }
  twilioAuthToken: { env: TWILIO_AUTH_TOKEN, type: string }
targets:
  - !ref sendCode
---
kind: SmsTwilio.Transport
metadata: { name: sms }
accountSid: !cel "secrets.twilioAccountSid"
authToken: !cel "secrets.twilioAuthToken"
from: "+15557654321"
---
kind: Telo.Sequence
metadata: { name: sendCode }
steps:
  - name: send
    invoke: !ref sms
    inputs: { to: "+15551234567", text: Your sign-in code is 123456. }
```

How the message maps onto Twilio's request, and how to write another HTTP SMS
provider in the same shape: [docs/providers.md](docs/providers.md).

## Tests

`tests/send.yaml` runs against a local stand-in for Twilio and needs no account.
