---
description: "Share a local telo run publicly with telo run --share: every tcp port gets an HTTPS address through a runner, the app's Telo.PublicUrl needs are answered from it, names, takeover, watch, shares list and delete, and what a visitor sees when the run is away."
---

# Sharing a local run

An application run with `telo run` is reachable only from the machine running
it. `telo run --share` makes every `tcp` port of the root Application reachable
publicly through a **runner**, and answers the application's `Telo.PublicUrl`
needs with the addresses it got, so the links, redirects and OAuth callbacks the
app builds point at an address a visitor can open — with nothing to copy by hand.

```console
$ telo login
$ telo run --share ./webhook-demo
Shared through https://runner.telo.run (share k3xqz2m7ahc4):
  http   8080      https://8080-k3xqz2m7ahc4.telorun.dev   site
  admin  9090      https://9090-k3xqz2m7ahc4.telorun.dev
  stats  8125/udp  not shared: udp
```

Everything `telo run --share` prints goes to stderr. Anyone who has an address
can open it, so share a run only while you are watching it.

## What the application needs

Nothing in its manifest. The app below has two HTTP ports, a `Telo.PublicUrl`
need and one `udp` port; `--share` shares the first two and lists the third as
not shared:

```yaml
kind: Telo.Application
metadata: { name: WebhookDemo }
ports:
  http: { env: PORT, default: 8080 }
  admin: { env: ADMIN_PORT, default: 9090 }
  stats: { env: STATS_PORT, protocol: udp, default: 8125 }
needs:
  site: { kind: Telo.PublicUrl, parameters: { port: http } }
```

- Every `tcp` port gets its own `<port>-<id>` address, and every address the
  runner's templates derive for a `Telo.PublicUrl` is added.
- A `Telo.PublicUrl` whose `TELO_NEED_…__URL` you set keeps that value and is
  listed as `not shared: set by TELO_NEED_SITE__URL`: whoever sets it is its host.
- A `Telo.PublicHostPattern` need, or a `customDomains` one, still comes from
  the environment, as for any partial host.
- A port that does not speak HTTP answers visitors `502`.
- An application declaring `Telo.DesktopHost`, or no `tcp` port, cannot be shared.

## The runner and signing in

`--share` goes to the runner `--share-runner <url>` names, else the one in
`TELO_RUNNER_URL`, else `https://runner.telo.run`. The runner must offer shares:
one that does not refuses the run before it asks for anything. `--share-runner`
is legal only beside `--share`.

Before any sign-in is sent to a runner, telo checks that the runner is the one it
named: the runner must identify as the URL you gave, accept sign-ins from the
accounts service telo is configured for (`TELO_ACCOUNTS_URL`, default
`https://accounts.telo.run`) and accept ES256 proofs. A runner that disagrees is
refused with `ERR_RUNNER_IDENTITY_MISMATCH`, naming what differs, and no token is
sent to it.

### Signing in

`telo auth login` signs this machine in to Telo Cloud and the runner with one
approval; `telo login` is the same command. It opens your browser on the sign-in
page and waits for you to approve. Over SSH, where no display or `BROWSER` is
found (Linux), when the browser cannot be opened, or with `--device-code`, it
prints a short code and the address to enter it at instead, so any browser will
do. The page address or the code is always printed, whether or not a browser was
opened. `--runner <url>` names the runner the sign-in covers (else
`TELO_RUNNER_URL`, else `https://runner.telo.run`). Ctrl-C cancels a login.

```console
$ telo auth status
Signed in to https://accounts.telo.run as alice
  cloud https://console.telo.cloud/api
  runner https://runner.telo.run
```

- `telo auth status` asks accounts whether the sign-in still holds. It exits 0
  when it does, and 1 when you are signed out or accounts cannot be reached.
  `-o json` writes `{ ok, signedIn, issuer, account: { sub, username },
  resources: { cloud, runner }, verified, problem? }`, the same document
  `telo auth login -o json` writes, which for a failed login carries
  `ok: false`, whether a sign-in is still stored, and `problem: { code, message }`.
- `telo auth logout` (or `telo logout`) revokes the sign-in at accounts and
  forgets it on this machine. Signing in again replaces an earlier sign-in and
  revokes it too; if accounts cannot revoke it, the new sign-in still works and a
  warning says the earlier one stays valid until you revoke it under Apps and
  devices at the accounts service.
- The sign-in is kept in `credentials.json` in telo's per-user state directory
  (`~/.local/share/telo`, `~/Library/Application Support/telo`,
  `%LOCALAPPDATA%\telo`), readable by you alone (mode 0600). A `telo auth login`
  in another terminal reaches a share that is already running without a restart.
- `TELO_ACCOUNTS_URL` and `TELO_CLOUD_API_URL` choose the accounts service and the
  Telo Cloud API; see [Environment variables](/reference/environment-variables).

At a terminal, `telo run --share` and `telo shares` offer to sign in when no
sign-in covers the runner, before anything is created:

```console
$ telo run --share ./webhook-demo
Sign in to Telo now? [Y/n]
```

Enter signs in and the run goes on. Answering no, running without a terminal, or
`--no-input` refuses with `ERR_RUNNER_SIGN_IN_REQUIRED` and the command to run
(`run: telo auth login`, with `--runner <url>` only for a runner other than the
default one). The offer is made only before the application starts: once it runs,
stdin is the application's.

## Names, and the same address tomorrow

A share stays the signed-in user's until it is deleted or, while not connected,
until the runner's retention period has passed. Its **name** decides which share
a run takes:

- `telo run --share ./app` names the share with a UUID minted once per real
  manifest path and kept in `share-names.json` in telo's per-user state
  directory. Running the same app again gets the same addresses; a copy in
  another directory gets its own, with its own cookies. No path of yours goes to
  the runner.
- `telo run --share=demo ./app` names it `demo`: the same share on every machine
  signed in as the same user.

## Takeover, and a share that goes away

A second run of the same share takes it over, and the first run ends:

```console
error ERR_SHARE_LOST: share k3xqz2m7ahc4 was taken over by another run
```

Deleting a share (`telo shares delete`) ends the run holding it the same way,
naming that it was deleted. Both exit with status 1.

While the tunnel is away — your network dropped, the sign-in expired, you
already have as many shares connected as the runner allows, or the runner is at
capacity — the app keeps running, visitors get `503` with `Retry-After`, and
`telo run` warns once per reason and reconnects, saying `Share <id> reconnected.`
when it does. An expired sign-in names the `telo auth login` to run; the run is
never stopped to ask.

## Under `--watch`

The tunnel belongs to the run, so it survives every reload. A port added to the
manifest is announced without reconnecting:

```console
Reloaded: now also sharing
  metrics  9100    https://9100-k3xqz2m7ahc4.telorun.dev
```

## Your shares

```console
$ telo shares list
ID            NAME                                  APPLICATION  CONNECTED  LAST ACTIVE
p7d2wqe4r6tb  demo                                  WebhookDemo  yes        2026-11-13T10:42:07Z
k3xqz2m7ahc4  6f1c2a9e-4b7d-4e0a-9c3f-2d8e5b1a7c40  WebhookDemo  no         2026-11-13T10:41:15Z

$ telo shares delete k3xqz2m7ahc4
Deleted share k3xqz2m7ahc4
```

Both take `--runner <url>`. `-o json` writes `{ ok, shares }` and `{ ok, deleted }`
on stdout; a refusal is on stderr and `ok` is false.

## Refusals

| Code | When |
|---|---|
| `ERR_RUNNER_SIGN_IN_REQUIRED` | No sign-in covers the runner (or the one stored covers another runner); the hint is `run: telo auth login`. |
| `ERR_RUNNER_IDENTITY_MISMATCH` | The runner's advertised identity disagrees with the URL, `TELO_ACCOUNTS_URL` or ES256; nothing was sent to it. |
| `ERR_SIGN_IN_FAILED` | A login did not complete: denied, expired, timed out, cancelled or accounts could not be reached. |
| `ERR_SIGN_IN_REVOKE_FAILED` | `telo auth logout` forgot the sign-in on this machine but accounts could not revoke it (exit 1), or a login that replaced a sign-in could not revoke the earlier one (a warning, exit 0). |
| `ERR_SHARE_RUNNER_UNSUPPORTED` | The runner offers no shares, or speaks no tunnel generation this telo offers. |
| `ERR_SHARE_APP_UNSUPPORTED` | The root declares no `tcp` port, or `Telo.DesktopHost`. |
| `ERR_SHARE_HOST_VALUE_CONFLICT` | `TELO_HOST_PUBLIC_URL_TEMPLATE` or `TELO_HOST_PUBLIC_URL_SECONDARY_TEMPLATE` is set: `--share` is the host of the run's public addresses. |
| `ERR_SHARE_LOST` | The share was deleted or taken over while the run was going. |

The runner's own refusals — `too_many_shares` when you keep as many shares as it
allows — are printed with its words.

See [Providing needs](/learn/providing-needs#sharing-a-local-run) for how the
share acts as the host of a run's addresses.
