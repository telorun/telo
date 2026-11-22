# Token sets

A set is a `Telo.Provider` in a `KvStore.Store`. Every operation names one through its `tokens:` slot.

| Key | Meaning |
| --- | --- |
| `store` | The `KvStore.Store` the tokens live in. Replicas sharing a store share their tokens, so a token works once across all of them; an in-process store forgets every token at a restart. |
| `name` | The durable identity of the set (`A-Z a-z 0-9 _ . -`, up to 64): part of every key it writes. Renaming the resource keeps its tokens; changing `name` voids them. |
| `expiresIn` | How long a token stays redeemable. Required. |
| `reissueAfter` | How long after a token is issued the same subject may be issued another. `60s` when omitted, `0s` for none. |
| `dataType` | The shape of the `data` a token carries from `Issue` to its redemption. Optional; without it a token carries `null`. It is stored as plain JSON. |
| `bytes` (`Links`) | Random bytes in the secret, 32 by default, at least 16. The token is their base64url text. |
| `digits` (`Codes`) | Decimal digits in a code, 6 to 10, default 6. |
| `maxAttempts` (`Codes`) | Wrong guesses a code takes, default 5. |

Two sets claiming one `name` on one store would write each other's records. That is `ONE_TIME_NAME_DUPLICATE` at `telo check`, reported as `RESOURCE_RULE_VIOLATED` on each set (links and codes alike), and `ERR_ONE_TIME_NAME_DUPLICATE` (`data: { name }`) when the second is created. The start-time refusal covers the sets of one running application: two applications sharing one store cannot see each other's names.

## One live token per subject

A set holds at most one live token per subject (an email, a user id, an invitation). Issuing again replaces the previous token, so "resend the code" voids the old one. A redeemed or revoked token does not hold the subject back.

## Guessing is bounded in the set

An issue within `reissueAfter` of the subject's previous one is answered `{ issued: false, retryAfter }` and the previous token stays live. A code therefore takes at most `maxAttempts` guesses per `reissueAfter` per subject: exhausting a code keeps its issue time, so the subject is not free to be issued another before `reissueAfter` has passed. The bound lives in the set, not in a route guard, because a guard is optional and keyed per client.

Two consequences to design for:

- Anyone who can ask for a token for a subject can keep that subject waiting `reissueAfter` for a new one: an attacker reissuing for a victim blocks the victim's own request for that long. Keep `reissueAfter` short enough to live with, and `maxAttempts` small.
- `reissueAfter` also bounds the mail or messages a caller can make the application send for one subject.

## What is stored

| Key | Holds |
| --- | --- |
| `<name>/t/<sha256(subject)>` | The live token of the subject: the `subject` (a link redemption answers it), the digest of the token (a code is digested together with its subject), `data`, the digest of `holder`, `issuedAt`, `expiresAt` and, for a code, the attempts left. |
| `<name>/l/<sha256(token)>` | Links only: the subject digest. The lookup grants nothing — a token is live only while the subject record holds its digest. |

A dump of the store yields no usable link. A code's digest can be brute-forced offline from a dump while the code lives, which is why a code set's `expiresIn` should be minutes. Digest comparisons are constant-time.

## Concurrency and crashes

- **Issue** reads the subject record, answers `issued: false` inside `reissueAfter`, otherwise writes the new lookup, replaces the record with one conditional write on the version it read, then deletes the old lookup. A crash leaves at most a lookup that reads as `unknown`, never two redeemable links. Two concurrent issues give one `issued: true`; the loser rereads and answers `issued: false`. With `reissueAfter: 0s` both may succeed one after the other, the later replacing the earlier.
- **A link redemption** compares holder, digest and expiry, then makes one `compareAndDelete` on the subject record, so a link works exactly once across every replica.
- **A wrong code** is one `compareAndSet` taking an attempt.
- A write that loses a race rereads and reapplies, up to eight times, then fails with `ERR_ONE_TIME_CONTENDED`; repeating the call is safe.
- A store that throws is `ERR_ONE_TIME_STORE_UNAVAILABLE`, the thrown value its `cause`; a cancellation passes through. A failure while an issue removes the old link's lookup leaves the new token live but unannounced, so the subject waits `reissueAfter`.
