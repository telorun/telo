# Session.Sessions

A `Telo.Provider` holding a set of sessions in a `KvStore.Store`. Every other kind of this module names one through a `sessions:` slot.

| Key | Meaning |
| --- | --- |
| `store` | The `KvStore.Store` the sessions live in. Replicas sharing a store share their sessions and their logouts; an in-process store ends every session at a restart. |
| `name` | The durable identity of the set (`A-Z a-z 0-9 _ . -`, up to 64): part of every key it writes. Renaming the resource keeps its sessions; changing `name` ends them. Two sets claiming one name on one store are refused (below). |
| `idleTimeout` | How long a session stays valid without a request. |
| `absoluteLifetime` | How long a session may live from the moment it starts, however busy it is. |
| `persistent` | `{ idleTimeout, absoluteLifetime }` for a session started with `persistent: true` (remember me). Without it, starting one is refused. |
| `maxPerSubject` | How many sessions one subject may hold at once. Default 50, at most 1000. |

An idle timeout longer than its absolute lifetime, in either pair, is `SESSION_LIFETIME_INVALID` at `telo check` (reported as `RESOURCE_RULE_VIOLATED` with that rule) and `ERR_SESSION_LIFETIME_INVALID` at start.

Two sets claiming one `name` on one store would write each other's records, and each set's tokens would be accepted by the other's verifier. That is `SESSION_NAME_DUPLICATE` at `telo check`, reported as `RESOURCE_RULE_VIOLATED` on each set involved, and `ERR_SESSION_NAME_DUPLICATE` (`data: { name }`, the message naming both sets) when the second is created. One name on two stores, or two names on one store, is fine. A store a library receives through its `resources:` inputs is known there by its kind alone, so its check reports the rule skipped (`RESOURCE_RULE_SKIPPED`) and the start-time refusal is what decides. That refusal covers the sets of one running application: two applications sharing one store cannot see each other's names.

## The token

`<22 base-62 id><43 base-62 validator>`, 65 characters, so it is a valid cookie value. The id names the session in the store and its public form is `ses_<id>`; the validator is a 256-bit secret of which only the SHA-256 digest is stored, compared in constant time. The token is returned once by `Session.Start` and cannot be read again. `Session.Start` always mints a fresh id, so a session cannot be fixed by presenting a chosen one.

## What is stored

| Key | Holds |
| --- | --- |
| `<name>/s/<id>` | The session: the validator's digest, the principal, `amr`, `acr`, `authenticatedAt`, `createdAt`, the creating client's `userAgent` and `address`, `lastSeenAt` and the absolute `expiresAt`. |
| `<name>/u/<sha256(subject)>` | The subject's index: at most `maxPerSubject` entries `{ id, expiresAt }`. |

**A session is accepted only while it is listed in its subject's index.** That is what makes ending sessions cheap and atomic: `Session.EndAll` is one write to one record, and `Session.Start` lists the new session in the index first and writes the session second, so a crash between the two leaves an entry naming nothing rather than a live session no one can revoke. The records of ended sessions are not deleted; they run out their TTL (the session's remaining life plus a minute, so a refusal can say `expired` rather than `unknown`) and are refused meanwhile.

Past `maxPerSubject` the oldest listed session is ended and reported by `Session.Start` in `ended`.

## Sliding the idle deadline

A verified request extends the idle deadline with one `compareAndSet` that renews the record's TTL, but only once a tenth of `idleTimeout` has passed since the last extension: a session is written at most about ten times per idle period, however busy. The idle timeout is therefore accurate to within a tenth. A slide that loses to a concurrent replica's write is an outcome, not an error — that write extended the deadline too.

## Contention

Writes to a subject's index are conditional. One that loses a race reads the index again and re-applies, up to eight times; after that the operation fails with `ERR_SESSION_CONTENDED` and may simply be repeated.

## Store failures

Every call to the store is guarded in one place. A store that throws, from any operation, the verifier's slide and every index update included, raises `ERR_SESSION_STORE_UNAVAILABLE` with no `data` and the store's thrown value as `cause`; nothing is swallowed. A cancellation (`ERR_INVOKE_CANCELLED`) and a durable suspension pass through unchanged, and so do this module's own codes. A store that answers a freshly minted session id as already taken, which a key/value store cannot do, raises the terminal `ERR_SESSION_STORE_INCONSISTENT`; it is never retried, because a retry would list another entry and could push the subject's real sessions out of the index.

## Not stored here

CSRF protection is the transport's: the cookie is read by `Http.FromCookie`, which makes the server apply its origin check ([the cookie](./cookie.md)). Stateless sessions are a recipe, not a kind ([stateless sessions](./stateless.md)).
