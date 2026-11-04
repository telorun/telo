# Sms

`sms` — sending text messages (one-time codes, verification and sign-in links,
alerts, notifications) through one contract that every transport implements, so
an application or library names the contract and the deployment decides who
delivers.

## Kinds

- **`Sms.Transport`** — abstract invocable, the contract. Inputs
  `{ to, from?, text }`, `to` and `from` being E.164 numbers (`+15551234567`);
  output `{ messageId, status }`, `status` being `sent` or `queued`. Its
  `throws:` ceiling is `ERR_SMS_REJECTED` (the message, sender, recipient or
  credentials refused) and `ERR_SMS_UNAVAILABLE` (unreachable, timed out, failed
  on its side, or refused temporarily).
- **`Sms.Capture`** — records each message in memory and answers a fresh message
  id with status `sent`. For tests and development.
- **`Sms.CaptureRead`** — invocable over one capture (`capture: !ref …`). Input
  `{ to? }`, output `{ messages }`: the recorded messages oldest first, each as it
  was sent plus its `messageId`, optionally only those sent to one number.

The contract, how failures are classified and how to test with the capture pair:
[docs/transports.md](docs/transports.md). A provider ships as its
own module extending `Sms.Transport`.

## Example

```yaml
kind: Telo.Library
metadata: { name: SignIn, version: 1.0.0 }
resources:
  sms: { kind: Sms.Transport }
imports:
  Sms: oci://ghcr.io/telorun/sms@<version>
---
kind: Telo.Sequence
metadata: { name: sendCode }
inputType:
  kind: Telo.JsonSchema
  schema:
    type: object
    required: [phone, code]
    properties: { phone: { type: string }, code: { type: string } }
steps:
  - name: send
    invoke: !ref sms
    inputs:
      to: !cel "inputs.phone"
      text: !interpolate "Your sign-in code is ${{ inputs.code }}."
```

## Tests

`tests/capture.yaml` runs in the module suite.
