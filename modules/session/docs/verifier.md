# Session.Verifier

Extends `Auth.Verifier`. It takes `sessions`, a `Session.Sessions`.

## Reading a session

1. It accepts only `token` presentations, from any credential source — normally `Http.FromCookie`, but `Http.FromAuthorization` works the same, since a presentation says what the material is and not where it came from. Any other variant is refused as `malformed`.
2. A token of the wrong length or alphabet is `malformed`, with the store not asked.
3. It reads the session. No such session, or a validator whose digest does not match (compared in constant time), is `unknown`.
4. A session past its idle deadline or its absolute deadline is `expired`.
5. It reads the subject's index. A session not listed there is `ended`.
6. Once a tenth of the idle timeout has passed since the last extension, it extends the idle deadline ([sliding](./sessions.md#sliding-the-idle-deadline)).

That is two reads per request, and one write about every tenth of an idle period.

## Answers

A refusal is returned, never thrown: `{ refused: true, reason, challenge: null }` with `reason` one of:

| Reason | When |
| --- | --- |
| `malformed` | Not a token presentation, or not shaped like a session token. |
| `unknown` | No such session, or the secret does not match. |
| `ended` | The session was ended: by `Session.End` or `Session.EndAll`, rotated, or pushed out by `maxPerSubject`. |
| `expired` | The idle timeout or the absolute lifetime has passed. |

The reason is for logs and operators only. The verifier publishes `challenges: []`: the scheme a caller is asked for comes from the credential source (`Http.FromCookie { scheme: Session }`). It declares no `issuer`, which `Auth.Verifier` reserves for an authorization server whose tokens it accepts.

A store that cannot be reached throws `ERR_SESSION_STORE_UNAVAILABLE` (the store's error is its `cause`), which the HTTP server answers as 503.

## The principal

The principal stored at `Session.Start`, with these filled from the session:

| Member | Value |
| --- | --- |
| `sessionId` | The public id, `ses_…`. |
| `amr`, `acr` | As started. |
| `authenticatedAt` | When the user signed in. |
| `via` | The verifier's name. |
