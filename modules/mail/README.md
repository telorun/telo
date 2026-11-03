# Mail

`mail` — sending transactional email (verification links, password resets,
receipts, notifications) through one contract that every transport implements,
so an application or library names the contract and the deployment decides who
delivers.

## Kinds

- **`Mail.Transport`** — abstract invocable, the contract. Inputs
  `{ from?, to, cc?, bcc?, replyTo?, subject, text?, html?, headers?, attachments? }`,
  at least one of `text` and `html`; output `{ messageId, accepted, rejected }`.
  Recipients being rejected while others are accepted is a result, not an error.
  Its `throws:` ceiling is `ERR_MAIL_REJECTED` (the message, sender, credentials
  or every recipient refused) and `ERR_MAIL_UNAVAILABLE` (unreachable, timed out,
  failed on its side, or refused temporarily).
- **`Mail.Smtp`** — delivers over SMTP through a connection pool. Config: `host`,
  `port`, `secure`, `starttls` (`require` by default | `opportunistic` | `never`), `auth`
  (`{ user, pass }`), the default sender `from` (required), `pool`
  (`{ maxConnections, maxMessages }`) and `timeout`.
- **`Mail.Capture`** — records each message in memory and answers a fresh
  message id with every recipient accepted. For tests and development.
- **`Mail.CaptureRead`** — invocable over one capture (`capture: !ref …`). Input
  `{ to? }`, output `{ messages }`: the recorded messages oldest first, each as it
  was sent plus its `messageId`, optionally only those with an address among
  their `to` recipients.

The contract, the SMTP settings, how failures are classified and how to test
with the capture pair: [docs/transports.md](docs/transports.md).

## Example

```yaml
kind: Telo.Application
metadata: { name: Shop, version: 1.0.0 }
imports:
  Mail: oci://ghcr.io/telorun/mail@<version>
secrets:
  smtpPassword: { env: SMTP_PASSWORD, type: string }
---
kind: Mail.Smtp
metadata: { name: mail }
host: smtp.example.com
port: 587
starttls: require
auth: { user: shop, pass: !cel "secrets.smtpPassword" }
from: { name: Shop, address: no-reply@example.com }
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

## Tests

`tests/capture.yaml` runs in the module suite. `tests/integration/smtp.yaml`
starts its own Mailpit container and runs under `pnpm run test:integration`.
