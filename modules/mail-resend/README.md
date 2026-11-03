# MailResend

`mail-resend` — sending transactional email through the
[Resend](https://resend.com) API behind the `Mail.Transport` contract, so an
application or library written against `mail` switches to Resend by declaring
this transport instead of another.

## Kinds

| Kind | Purpose |
| --- | --- |
| `MailResend.Transport` | Send one email through Resend's `POST /emails`. |

`MailResend.Transport` extends `Mail.Transport`: it takes the contract's message
and answers `{ messageId, accepted, rejected }` with Resend's id, every `to`,
`cc` and `bcc` address accepted and `rejected` empty, since Resend accepts or
refuses a message whole. Config:

| Field | Default | Meaning |
| --- | --- | --- |
| `apiKey` | — | The Resend API key, sent as a bearer token. Required; take it from `secrets:`. |
| `from` | — | The sender of every message naming none, on a domain verified with Resend. Required. |
| `baseUrl` | `https://api.resend.com` | Where the API is reached, without a trailing slash. |

A 4xx answer other than 408 and 429 is `ERR_MAIL_REJECTED`; 408, 429, any other
answer that is not a 2xx, a 2xx without a message id, and a request that never
got an answer are `ERR_MAIL_UNAVAILABLE`. The error message carries Resend's own
explanation.

## Example

```yaml
kind: Telo.Application
metadata: { name: Shop, version: 1.0.0 }
imports:
  MailResend: oci://ghcr.io/telorun/mail-resend@<version>
secrets:
  resendApiKey: { env: RESEND_API_KEY, type: string }
targets:
  - !ref sendReceipt
---
kind: MailResend.Transport
metadata: { name: mail }
apiKey: !cel "secrets.resendApiKey"
from: { name: Shop, address: no-reply@shop.example }
---
kind: Telo.Sequence
metadata: { name: sendReceipt }
steps:
  - name: send
    invoke: !ref mail
    inputs:
      to: { name: Ada Lovelace, address: ada@example.com }
      subject: Your receipt
      text: Thanks for your order.
```

How the message maps onto Resend's request, and how to write another HTTP
provider in the same shape: [docs/providers.md](docs/providers.md).

## Tests

`tests/send.yaml` runs against a local stand-in for Resend and needs no account.
