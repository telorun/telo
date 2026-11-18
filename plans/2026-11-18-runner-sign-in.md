---
status: done
priority: high
depends-on: []
packages: [cli, packages/share-tunnel]
refinement: not-started
---

# Runner sign-in for the CLI

## Problem

`telo run --share` and `telo shares list|delete` shipped, but no person can use them. The CLI's runner credential provider is a placeholder: every runner answers "sign in", so each command stops at once:

```console
$ telo run --share ./webhook-demo
error ERR_RUNNER_SIGN_IN_REQUIRED: sharing needs a sign-in to https://runner.telo.run
  run: telo auth login --runner https://runner.telo.run
```

The command the hint names does not exist. Telo accounts already supports this sign-in. It registers the public native client `telo-cli`, which can sign in through a loopback redirect or a device code and may refresh. One approval yields one grant covering both `cloud` and the first-party runner, bound to the CLI's DPoP key from the first request, with one token per audience. Accounts never stores consent for a public client, and the token endpoint uses DPoP nonces. The sharing design also expects the CLI to check that a runner's advertised `identity.resource` is the runner it connected to before it sends a token. That check is not implemented either, so a runner could collect a token that is valid at another runner.

## Constraints

- no self-hosted runners
- user just has to login to whole cloud and the runner
- no CI / non-interactive credential
- alias like `telo login`
- `--share` at a terminal with no sign-in offers to sign in right there
- keep signin inside cli

## Surface

**Added**
- `telo auth login [--runner <url>] [--device-code]` — signs this machine in to Telo Cloud and the runner with one approval.
- `telo auth logout` — revokes the sign-in at accounts and forgets it on this machine.
- `telo auth status` — the signed-in account and what it covers, confirmed with accounts; `-o json` answers `{ ok, signedIn, issuer, account: { sub, username }, resources: { cloud, runner }, verified, problem? }`, the document `telo auth login -o json` also answers.
- `telo login`, `telo logout` — aliases of `telo auth login` / `telo auth logout`.
- `TELO_ACCOUNTS_URL` — the accounts issuer the CLI signs in with (default `https://accounts.telo.run`).
- `TELO_CLOUD_API_URL` — the Telo Cloud API, the grant's `cloud` resource (default `https://console.telo.cloud/api`).
- `credentials.json` in telo's per-user state directory (`~/.local/share/telo`, `~/Library/Application Support/telo`, `%LOCALAPPDATA%\telo`) — the sign-in, versioned, mode 0600, one record per issuer.
- `credentials.json.lock` beside it — taken by whichever process refreshes or changes the sign-in.
- `Sign in to Telo now? [Y/n]` — the offer `telo run --share` and `telo shares` make at a terminal with no sign-in.
- `telo shares list|delete --no-input` — refuse instead of offering sign-in at a terminal.
- `ERR_RUNNER_IDENTITY_MISMATCH` — a runner's advertised identity disagrees with the configuration.
- `ERR_SIGN_IN_FAILED` — a login did not complete: denied, expired, timed out, cancelled, or accounts could not be reached.
- `ERR_SIGN_IN_REVOKE_FAILED` — logout forgot the sign-in locally but could not revoke it at accounts; also a warning (exit 0) on a login that replaced a sign-in it could not revoke.

**Changed**
- `ERR_RUNNER_SIGN_IN_REQUIRED` — its hint becomes `run: telo auth login`, with `--runner <url>` only for a runner other than the one login resolves to; it also covers a sign-in that does not cover the runner.
- `telo run --share`, `telo shares list|delete` — at a terminal without `--no-input` they offer sign-in instead of refusing.

**Removed**
- None.

## Solution

**One login, one grant.** `telo auth login` authorizes the `telo-cli` client with accounts once. It sends `resource=` for the Cloud API and for the runner, `offline_access` and the client's registered scopes, and a `dpop_jkt` for a fresh ES256 key generated at login. One refresh token comes back, bound to that key. The CLI asks for tokens one audience at a time. Today only the runner audience is requested; `cloud` is part of the grant so that a later Cloud command needs no second approval. The account is read from the ID token's `sub` and `preferred_username`; accounts puts nothing else in `telo-cli`'s ID token, so email and name are never read, stored or shown. A login asks for the runner audience only: no userinfo call, no Cloud token.

**Browser when one can reach the person, a code otherwise.** Login uses the authorization-code flow with PKCE on a `127.0.0.1` loopback redirect, on an OS-chosen port. It switches to the device-code flow in these cases:
- `SSH_CONNECTION` or `SSH_TTY` is set;
- on Linux, `DISPLAY`, `WAYLAND_DISPLAY` and `BROWSER` are all unset;
- the browser fails to launch;
- `--device-code` is given.

The URL, and the code in the device flow, are always printed on stderr. A loopback login waits 10 minutes and a device login waits the code's `expires_in`; then it fails with `ERR_SIGN_IN_FAILED`.

**Pinned issuer, checked runner.** The issuer comes from `TELO_ACCOUNTS_URL`, the Cloud resource from `TELO_CLOUD_API_URL`, and the runner from the existing rule: `--runner` / `--share-runner`, else `TELO_RUNNER_URL`, else `https://runner.telo.run`. A runner never chooses the issuer. Before any token is requested for a runner, the CLI checks the runner's RFC 9728 metadata. It reads `/.well-known/oauth-protected-resource` at login, and `identity` on `/v1/capabilities` for shares. The runner agrees when:
- its `resource` equals the runner URL, after scheme and host are lowercased, a default port is dropped and the trailing slash removed;
- the configured issuer is in its `authorization_servers`;
- `ES256` is in its `dpop_signing_alg_values_supported`.

When it disagrees, the CLI refuses with `ERR_RUNNER_IDENTITY_MISMATCH`, naming what disagreed. When it agrees but the stored grant does not cover it, the answer is `ERR_RUNNER_SIGN_IN_REQUIRED`, with the `--runner` hint. A token for one resource is only ever handed to a request for that exact URL.

**The file is the only source of truth.** Every credential request re-reads `credentials.json`. That is how a `telo auth login` in another terminal brings a running share back without a restart. Each record holds:
- the client id;
- the DPoP private key as a JWK;
- the refresh token;
- the covered resources;
- the account;
- each audience's access token and its `expiresAt`;
- when the sign-in was made.

The file is written to a 0600 temporary file and renamed into place, inside a 0700 directory, by the one atomic-write function `share-names.json` uses too. Every write happens under the store's lock; before it, the function removes every other `<file>.*.tmp` beside the store (a crashed writer's), and it refuses to write when the lock was taken over since it was taken. The lock module removes its own `.stale` leftovers when it takes the lock. A stored token that outlives the caller's minimum lifetime is used without locking. Otherwise the process takes `credentials.json.lock`, re-reads the file and uses a token another process just wrote. If none was written, it refreshes, then writes the rotated refresh token and the new access token before releasing the lock.
- A `use_dpop_nonce` answer is re-sent with the nonce; that is part of the protocol, not a retry.
- A refresh whose answer was lost is re-sent once under the same lock, inside accounts' 30-second window for identical retries. Otherwise the rotated token would be treated as reused, and the grant revoked.
- A lock older than 60 s is taken over. A process that has waited 30 s answers `unavailable`, saying another telo process holds the sign-in.
- `invalid_grant` deletes the record and answers `sign-in-required`.
- Network failures and 5xx answers come back as `unavailable`, naming the issuer and the cause.

The lock is the one the share-name store already uses, made into one CLI module that both stores call.

**Offered where it is needed.** `telo run --share` checks the runner's `features.shares` and its identity first. If the first credential request then answers `sign-in-required`, and stdin and stderr are terminals and `--no-input` is absent, the CLI asks `Sign in to Telo now? [Y/n]`; Enter means yes. A yes runs the same login as `telo auth login --runner <runner>` and then asks for the credential again, so the share is still created before the kernel is built. `telo shares list|delete` makes the same offer before their first request. A no, or no terminal, refuses with the hint. A sign-in lost mid-run (tunnel close `4401`, or `sign-in-required` on reconnect) never prompts, because stdin belongs to the application. The CLI warns once with the hint and keeps reconnecting.

**A new login revokes what it replaces.** After the new sign-in is written, and the lock released, the CLI revokes at `/oauth2/revoke` the refresh token of the record it replaced — the one in the file when the new record was written, read in the same locked read-modify-write, so it is the latest rotated token. A failed revocation leaves the login a success (exit 0, `problem` with `ERR_SIGN_IN_REVOKE_FAILED`, also on stderr): the earlier sign-in stays valid until revoked under "Apps and devices". A first login revokes nothing.

**Logout and status.** `telo auth logout` revokes the refresh token at accounts' `/oauth2/revoke` under the lock, then deletes the record whatever accounts answered. If revocation failed, it exits 1 with `ERR_SIGN_IN_REVOKE_FAILED`, saying the machine is signed out and the grant can be revoked under "Apps and devices" at accounts. With no sign-in, logout says so and exits 0. `telo auth status` confirms the sign-in by refreshing the runner audience under the lock. It prints `Signed in to <issuer> as <username>` (the subject when there is no username) and one line per covered resource. It exits 1 when signed out or when confirmation fails (`verified: false`, `problem` naming the cause).

**Where it lives.** Everything is in `cli/nodejs`, which already reaches the runner only through `@telorun/runner-protocol` and `@telorun/share-tunnel`. The CLI holds:
- the flows, PKCE, DPoP keys and proofs, token requests;
- the `credentials.json` store and its lock;
- the `telo auth` commands;
- the prompts, which go through `Output`.

The composition root wires the sign-in in as the `RunnerCredentialProvider` in place of the placeholder. `@telorun/share-tunnel`'s port is unchanged, except that its documentation says a request whose answer was lost is settled within the same attempt.

**Docs and bookkeeping.**
- `TELO_ACCOUNTS_URL` and `TELO_CLOUD_API_URL` in `docs/reference/environment-variables.md`.
- The sign-in step and its hints in `docs/guides/sharing-a-local-run.md`.
- The CLI reference, `cli/README.md`: a `telo auth` section, and the sign-in refusals in `telo run --share` and `telo shares`.
- A line in the CLI guide recording the debt: `credentials.json` is a versioned on-disk contract that a future `cli/rust` `--share` must read as written.
- Release fragments for `cli` and `packages/share-tunnel`.
- No benefits-ledger entry: sign-in is the prerequisite of an entry that already exists, not a feature of its own.

## Decisions

- **One grant naming `cloud` and the runner, one token per audience.** This is the shape accounts implements. A runner-only login would force a second interactive approval the first time a Cloud command lands, because a public client's consent is never kept.
- **The `auth` group with top-level aliases, no `whoami`.** It is the gh / gcloud shape, plus the npm / docker / vercel spelling the user asked for. `status` already reports the identity, so `whoami` would be a second word for one report.
- **The issuer is pinned by configuration; runner metadata is checked against it.** Discovering the issuer from the runner, as the MCP auth flow does, would let a mistyped `TELO_RUNNER_URL` choose the page where a person types their password. A fixed issuer would make staging and local environments impossible to sign in to.
- **A 0600 file, not the OS keychain.** That is what gcloud, the AWS SSO cache, flyctl, docker and npm do. A keychain is absent on headless Linux, which would mean a second, weaker mode. It still needs the cross-process lock, and it could prompt during a background reconnect.
- **Access tokens are shared through the file, under one lock, re-read before every refresh.** With rotating refresh tokens, exactly one process may rotate at a time. Per-process caches would rotate one token from N processes and present a stale one.
- **A lost refresh is settled inside the attempt.** If it were left to the caller's reconnect backoff, the retry would fall outside accounts' 30-second window, and one network blip would revoke the grant.
- **The browser by default, the device code over SSH, without a display, or on request.** This is Azure CLI's behaviour. A redirect to `127.0.0.1` over SSH lands on the remote machine, so a launch that succeeds would still fail.
- **The inline offer comes before boot and asks first.** Starting a login unasked would open a browser the person did not ask for. Once the application runs, stdin is the application's, so a lost sign-in only warns.
- **Logout always forgets locally and reports a failed revocation as an error.** The person asked for this machine to be signed out. A live grant left at accounts is reported with where to close it, never swallowed.
- **Status asks accounts.** A stored token does not prove the grant is still live; gh `auth status` checks the same way.
- **Kept inside the CLI** (user decision). A separate sign-in package was rejected.
