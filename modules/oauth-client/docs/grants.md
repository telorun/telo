# Grants and storage

A **grant** is what a sign-in leaves behind: an access token, when it expires, the
refresh token if the server issued one, and the scopes actually granted. It is
stored in the `KvStore.Store` a `TokenSource` names, addressed by a **key**.

## Keys are per call, not per resource

`TokenSource.key` is a *default*, not an identity. Every operation accepts a `key`
input that overrides it:

```yaml
- invoke: !ref CurrentToken
  inputs: { key: !cel "'user/' + request.params.userId" }
```

A browser-served application is inherently multi-user, and even a CLI may hold two
accounts for one provider. One `TokenSource` per account cannot express an account
set that is only known at runtime.

For a single-account program, ignore keys entirely — the source's default is used.

## Storage

Any `KvStore.Store` works. The guarantee that matters is the one that abstract
provides and `Cache.Store` does not: records are **not evicted** before their TTL,
and conditional writes are atomic. A refresh token dropped for memory pressure
means the user has to sign in again.

- `kv-store-sql` over SQLite — the usual local choice.
- `kv-store-sql` over Postgres, or `kv-store-redis` — for anything running on more
  than one instance.
- `kv-store-memory` — tests and single-process runs only; grants do not survive a
  restart.

`grantTtl` (default one year) bounds how long an untouched grant is retained. Every
refresh rewrites the record and restarts the clock, so this only affects accounts
that stop being used — roughly where providers expire an unused refresh token
anyway.

## Refresh

`AccessToken` and `Credential` refresh on their own: a token inside the
`refreshSkew` window (default 60 seconds) of expiry is treated as already expired,
which covers both clock difference against the server and the time the call itself
takes.

**Only one refresh per key runs at a time.** The refreshing caller claims
`refresh:<key>` on the same store the grant lives in; a caller that arrives while
someone holds it re-reads the grant the winner wrote instead of issuing its own
request. This is the same claim protocol `Lease.Critical` and `Idempotency.Once`
are built on, so the exclusion holds across processes.

That matters because of **rotation**. A server that rotates refresh tokens
invalidates the old one on use, and treats a second presentation as replay —
RFC 6749 §10.4 answers replay by revoking the whole grant. Serializing only the
*write* would leave both requests reaching the server, so the loser could take the
user's authorization down with it. When the server does rotate, the new refresh
token replaces the stored one; when it does not, the existing one is kept rather
than being dropped.

## Reading and clearing

`GrantRead` reports what is stored without refreshing anything — use it to decide
whether to prompt someone to sign in:

```yaml
- name: existing
  invoke: !ref ReadGrant
  inputs: { key: !cel "'user/' + inputs.userId" }
- if: !cel "!steps.existing.result.exists"
  then:
    - invoke: !ref Authorize
      # …
```

`hasRefreshToken: false` is worth branching on: an expired token with no refresh
token is the end of the road, and no amount of retrying will renew it.

`GrantClear` removes the record — a local sign-out. It does not tell the server to
revoke anything; token revocation is a separate endpoint this module does not yet
call.

## Using a grant

Prefer `Credential` on an `Http.Client` for HTTP: the call is then an ordinary
`Http.Request` with nothing re-declared, and no unauthenticated inner resource
exists for anything in the manifest to invoke and bypass authentication with.

`AccessToken` stays public for everything else — a gRPC metadata header, a
connection string, a message property.
