# Delivery: `mail`, `sms` and their providers

The delivery track of phase 0 in `plans/identity-and-access.md`. Four new bundled modules:
`mail` and `mail-resend`, `sms` and `sms-twilio`. Verification, password reset, magic links,
one-time codes and invitations in later phases all send an email or an SMS, and today no
module can.

**Dependency:** `sms-twilio` needs `Http.BasicAuth` from the transport plan
(`plans/2026-11-02-http-cookies-tls-basic.md`), so it lands after that. Everything else here is
independent.

## 1. `mail` (`Mail`)

**Before.** No module can send an email.

**After.** The module carries categories `[Messaging]`.

**`Mail.Transport`** is an abstract invocable, the contract every transport implements.

- Inputs: `{ from?, to, cc?, bcc?, replyTo?, subject, text?, html?, headers?, attachments? }`.
  - An address is a string or `{ name, address }`. `to`, `cc` and `bcc` take one address or a
    list.
  - An attachment is `{ filename, content (Telo.Bytes), contentType? }`.
  - At least one of `text` and `html` is required.
- Outputs: `{ messageId, accepted, rejected }`, where the last two are lists of addresses.
  Some recipients being rejected is an outcome, not an error.
- It declares a `throws:` ceiling every implementation falls within:
  - `ERR_MAIL_REJECTED`: the server or provider refused the message, or every recipient.
  - `ERR_MAIL_UNAVAILABLE`: the transport was unreachable, timed out, or failed on its side.

**`Mail.Smtp`** implements the transport over `nodemailer`, which is pure JS and inlined.

- It is configured with `host`, `port`, `secure` (implicit TLS),
  `starttls: require | opportunistic | never`, `auth: { user, pass }` (from `secrets:`), a
  default `from`, `pool` and `timeout`.
- The pooled transport is created in `init()` as one effect whose inverse closes it, so the
  module declares `requires: telo: ">=0.82.0"`.

**Capture for tests.** `Mail.Capture` implements the transport by recording each message in
memory and answering a generated `messageId`. `Mail.CaptureRead` (`capture: !ref Mail.Capture`,
input `{ to? }`) returns the recorded messages, newest last. Every later phase's tests send
through this pair.

**What phase 0 does not do.** Message templating (subjects and bodies per language) belongs to
a later phase (`passwordless`, i18n). Phase 0 delivers what it is handed.

**Verify.**

- `modules/mail/tests/capture.yaml`:
  - Send two messages through `Mail.Capture`, read them back with `Mail.CaptureRead`, and
    compare them in full with `Assert.Equals`.
  - The `to` filter.
  - A message with neither `text` nor `html` is refused by the contract.
- `modules/mail/tests/integration/smtp.yaml` runs outside the root suite, under
  `pnpm run test:integration`:
  - It starts a Mailpit container itself (`Container.Instance` over `Docker.Engine`).
  - It sends through `Mail.Smtp`, including an attachment, and reads the message back through
    Mailpit's HTTP API.
  - A closed port fails with `ERR_MAIL_UNAVAILABLE`.

## 2. `mail-resend` (`MailResend`)

**After.** `mail-resend` sets the pattern for an HTTP mail provider: one templated kind and no
controller. SendGrid, Postmark and Mailgun follow the same shape when someone wants them. SES
waits for request signing in phase 6.

- **`MailResend.Transport`** extends `Mail.Transport` and is configured with `apiKey` (from
  `secrets:`), a default `from`, and `baseUrl` (default `https://api.resend.com`, overridden by
  tests).
- **Its body is a `run:` step list:**
  1. An `Http.Request` posts to `/emails` through an inline `Http.Client` carrying
     `Http.BearerToken`.
     - `inputs:` map the message to Resend's JSON: snake_case keys, and attachment content
       through `base64Encode`.
  2. A `switch` on the status turns a 4xx into `ERR_MAIL_REJECTED` and anything else that is not
     a success into `ERR_MAIL_UNAVAILABLE`.
  3. `result:` maps `id` to `messageId`. Every recipient is `accepted` and `rejected` is empty,
     since Resend accepts or refuses the whole message.

**Verify.** `modules/mail-resend/tests/send.yaml`:

- An `Http.Server` in `with:` stands in for Resend and records the request.
- The test asserts the exact JSON body, the `authorization` header and the mapped result.
- A stand-in that answers 422 yields `ERR_MAIL_REJECTED`, and one that answers 503 yields
  `ERR_MAIL_UNAVAILABLE`.

## 3. `sms` (`Sms`)

**After.** The module carries categories `[Messaging]`.

- **`Sms.Transport`** is an abstract invocable.
  - Inputs: `{ to, from?, text }`. `to` and `from` are E.164 numbers, checked by the schema
    pattern `^\+[1-9][0-9]{1,14}$`.
  - Outputs: `{ messageId, status: queued | sent }`.
  - Its `throws:` ceiling is `ERR_SMS_REJECTED` and `ERR_SMS_UNAVAILABLE`, with the same split
    as mail.
- **`Sms.Capture` and `Sms.CaptureRead`** mirror the mail pair.

**Verify.** `modules/sms/tests/capture.yaml`:

- Send through `Sms.Capture`, then read back and compare in full.
- A number that is not E.164 is refused by the contract.

## 4. `sms-twilio` (`SmsTwilio`)

**After.**

- **`SmsTwilio.Transport`** extends `Sms.Transport` and is configured with `accountSid` and
  `authToken` (from `secrets:`), a default `from`, and `baseUrl` (default
  `https://api.twilio.com`).
- **Its body follows the `mail-resend` shape:**
  1. An `Http.Request` posts to `/2010-04-01/Accounts/<accountSid>/Messages.json`.
     - It goes through an inline `Http.Client` carrying `Http.BasicAuth`, with the account SID
       as the username and the auth token as the password.
     - The body is form-encoded, with `To`, `From` and `Body`.
  2. A status `switch` maps errors as for mail.
  3. `result:` maps `sid` to `messageId`. Twilio's `sent` and `delivered` map to `sent`, and
     every other accepted status maps to `queued`.

**Verify.** `modules/sms-twilio/tests/send.yaml`, against a stand-in server:

- It asserts the form body, the exact Basic `authorization` header, the path carrying the
  account SID, and the mapped result.
- It asserts both error codes.

## Cross-cutting

- **Packaging.**
  - `mail` and `sms` each have `modules/<name>/telo.yaml` with `license: MIT`, a `LICENSE`, a
    private `nodejs/` build package, `tests/*.yaml`, a `README.md`, `docs/`, and one
    `pkg:telo/local/js` bundle with one `#fragment` per kind.
  - `mail-resend` and `sms-twilio` have no `nodejs/`, since they have no controller.
  - `modules/README.md` gains a `Messaging` section listing all four modules.
- **Releases.** All four are new modules and take `telo release add` fragments only.
- **Floors.**
  - `mail` declares `telo: ">=0.82.0"` for its effect chain.
  - `mail-resend` and `sms-twilio` are each checked by running the previous published CLI
    against them. A floor is declared only if that run refuses their template body.
- **Docs.**
  - `mail` gets `docs/transports.md`, covering the contract, SMTP settings and capture in tests.
  - `mail-resend` gets `docs/providers.md`, explaining how to write another HTTP provider in
    the same shape.
  - `sms` gets the matching pair of docs.
- **Authoring agent.** The primer learns sending an email or SMS through a transport, and
  testing with the capture pair.
- **Benefits ledger.** Under Standard library → a new Messaging group: transactional email and
  SMS behind one contract, with a capture transport for tests.
