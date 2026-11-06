# Operations

Each names a `Session.Sessions` through `sessions:`. A subject is the principal's `subject`, which keys the per-subject index.

| Kind | Inputs | Output |
| --- | --- | --- |
| `Session.Start` | `principal`, `persistent?`, `userAgent?`, `address?` | `{ token, sessionId, expiresAt, cookieExpiresAt, ended }` |
| `Session.Rotate` | `sessionId`, `subject`, `principal?` | `{ token, sessionId, expiresAt, cookieExpiresAt }` |
| `Session.End` | `sessionId`, `subject` | `{ ended }` |
| `Session.EndAll` | `subject`, `except?` | `{ ended }` |
| `Session.List` | `subject` | `{ sessions }` of `Session.SessionInfo` |

**Start** always mints a fresh id. `principal` is the principal a password check answered; its `amr`, `acr` and `authenticatedAt` are kept (`authenticatedAt` is now when null). `persistent: true` starts a remembered session with the set's `persistent` lifetimes, and `cookieExpiresAt` is then its absolute deadline, to put in the cookie's `expires`; otherwise it is null and the cookie ends with the browser session. `expiresAt` is when the session ends if no request uses it. `ended` lists the public ids of the oldest sessions ended to stay within `maxPerSubject`. `token` is returned once.

**Rotate** is for a change of privileges (a role granted, a step-up): one write to the index swaps the old id for a new one, so the old token is `ended` at once. The new session keeps the old one's absolute deadline, creation time and sign-in, so rotating never extends a login. A new `principal` replaces the stored one; its subject must be `subject`. A session the subject does not hold (unknown, ended, expired, another subject's) is refused with `ERR_SESSION_NOT_FOUND`, one code for all of them on purpose, and nothing changes.

**End** answers `ended: false` for a session the subject does not hold, another subject's included.

**EndAll** is a single write to the index, so it is atomic: every copy of every ended token is refused from the next request on every replica. `except` keeps one session — typically the caller's own, `request.principal.sessionId` — and the output lists the ids ended.

**List** returns the subject's whole set (bounded by `maxPerSubject`), oldest first, with `id`, `createdAt`, `lastSeenAt`, `expiresAt`, `authenticatedAt`, `amr`, `acr`, `userAgent`, `address` and `persistent`. `lastSeenAt` is accurate to within a tenth of the idle timeout.

## Codes

| Code | Raised by | Meaning |
| --- | --- | --- |
| `ERR_SESSION_CONTENDED` | `Start`, `Rotate`, `End`, `EndAll` | The per-subject index compare-and-set kept losing ([contention](./sessions.md#contention)). Repeat the call. |
| `ERR_SESSION_NOT_FOUND` | `Rotate` | The subject holds no live session with this id. |
| `ERR_SESSION_STORE_UNAVAILABLE` | all, and the verifier | The store failed; no `data`, the store's error is the `cause`. `Start`: repeating is safe, a failed attempt may leave a session nobody holds a token for, ended by the cap or its lifetime. `Rotate`: the old session may already be ended; the user then signs in again. `End`, `EndAll`: repeating is safe. |
| `ERR_SESSION_STORE_INCONSISTENT` | `Start`, `Rotate` | The store took a freshly minted id. Terminal. |

A route's `catches:` should answer the codes of its handler. `End` answers `{ ended: false }` for a session the subject does not hold, and repeating it is not an error.

## A login route

```yaml
- request: { path: /login, method: POST }
  handler: { kind: Session.Start, sessions: !ref sessions }
  inputs:
    principal: !cel "request.body.principal"      # from the password check
    persistent: !cel "request.body.remember"
    userAgent: !cel "'user-agent' in request.headers ? request.headers['user-agent'] : null"
    address: !cel "request.ip"
  returns:
    - status: 204
      cookies:
        - cookie: !ref sessionCookie
          value: !cel "result.token"
          expires: !cel "result.cookieExpiresAt"
```
