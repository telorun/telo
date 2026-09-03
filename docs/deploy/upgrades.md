---
sidebar_label: Upgrades & version skew
slug: /deploy/upgrades
description: "Two things move independently in a deployed Telo app — the module pins in imports: and the kernel image that runs them. How requires: ties them together, what telo upgrade holds back, and the order that never strands one behind the other."
---

# Upgrades & version skew

A deployed application is two versioned things: the **module pins** in its
`imports:` map, and the **kernel** that loads them — the `@telorun/cli` version,
or the `telorun/node:<ver>` image tag. They are upgraded by different commands,
usually by different people, and nothing stops them drifting apart. This page is
about the one direction of drift that breaks, how the runtime names it, and the
habit that keeps it from happening.

## Which direction breaks

**An older module on a newer kernel is fine.** A manifest published years ago
still loads: every keyword rename ships as a
[migration](/extend/manifest-migrations) the loader applies in memory, and a
module that declares no requirement has none, permanently.

**A newer module on an older kernel is the problem.** Telo adds syntax as minor
releases — a new annotation, a new shape for an existing one, a new key on a
built-in doc — and every extension vocabulary hard-rejects an unknown token. So a
module that adopted new syntax fails on an older runtime with a diagnostic
pointing at *its own YAML* (`ZONE_ANNOTATION_INVALID`, `SCHEMA_VIOLATION`, an
`additionalProperties` violation), blaming the module's author for a version
skew in your deployment.

## What names the skew: `requires:`

A module declares the runtime range it is verified against:

```yaml
kind: Telo.Library
metadata:
  name: SQL
  version: 0.9.0
requires:
  telo: ">=0.82.0"
```

That block is what converts the failure above into one diagnostic that names the
cause:

```
telo.yaml  error  Telo.Library/SQL requires telo '>=0.82.0'; this runtime reports
0.80.0. Upgrade telo, or pin SQL to a version whose range accepts 0.80.0.
MODULE_REQUIRES_NEWER_RUNTIME
```

It is checked **first**, at load, by `telo check` and `telo run` alike, and every
other diagnostic anchored in that module is suppressed — they are consequences of
the same skew, not second defects. A `host:` axis (`requires: host: node:
">=22"`) is checked the same way against the machine actually running the
manifest; an IDE reports no host, so only the `telo` axis bites there.

The standard library declares these floors, and the guide for module authors is
[Declaring runtime requirements](/extend/declaring-runtime-requirements).

## What `telo upgrade` does with it

`telo upgrade` does not move a pin to the newest published version. It reads each
candidate version's own `telo.yaml`, newest first, and moves the pin to **the
newest version whose `requires:` accepts the CLI that is running the command**.
A version it passed over is reported, never swallowed:

```
Upgrading apps/my-app/telo.yaml
  ↑  oci://ghcr.io/telorun/sql  0.8.0 → 0.8.3
  ·  oci://ghcr.io/telorun/sql  0.9.0 available — it requires a newer telo than 0.80.0
```

That last line is the whole point. Without it a pin becomes a silent ceiling and
`up to date` becomes a lie. When *every* published version needs a newer runtime
than the one running, the import is left alone and reported as
`no published version is usable here`.

The consequence is easy to miss: **`telo upgrade` is only correct for the kernel
it runs on.** Run it on a developer machine with a fresh global CLI and it will
happily move pins past what your production image can read, because the CLI
doing the selecting is not the CLI that will do the loading.

## The habit: upgrade and check inside the target image

Run `telo upgrade` and `telo check` **with the same CLI version that will run
the manifest**. In a Docker deployment that is one command:

```bash
docker run --rm -v "$PWD":/w -w /w telorun/node:<ver>-slim \
  telo upgrade apps/my-app
docker run --rm -v "$PWD":/w -w /w telorun/node:<ver>-slim \
  telo check apps/my-app
```

with `<ver>` the exact tag your Dockerfile's `FROM` names. The first moves pins
only to versions that kernel can host; the second is the gate, and it fails with
`MODULE_REQUIRES_NEWER_RUNTIME` if a hand-written pin — a ref copied from the
hub, say — reaches past it. Put the `check` in CI and the skew cannot reach a
deploy.

If you deploy under a bare CLI instead, the same rule reads: pin `@telorun/cli`
in the environment that runs `upgrade` to the version installed on the hosts.

## Order of operations

Because the safe direction is *older module on newer kernel*:

1. **Move the kernel first.** Bump the `FROM telorun/node:<ver>-slim` tag (or
   the installed CLI), rebuild, `telo check` — every existing pin keeps loading.
2. **Then move the modules.** `telo upgrade` inside the new image now selects
   versions the new kernel can host that the old one could not.
3. **Check the pins came back.** `telo upgrade` rewrites each moved import with
   the new version *and* its `#sha256-` hash, and pins in place any import that
   was already current but unpinned. Fetching a hash is best-effort: an import
   reported as `left unpinned` needs one added by hand
   (`telo module digest <ref@version>` prints it) before the chain described in
   [Security & supply chain](/deploy/security) is whole again.

**Rolling back** is the other way round: put the *previous manifest* back with
the *previous image*, together. With the Docker recipe on this site the manifest,
its cache and the kernel are one image, so a rollback is the previous tag and
there is nothing to keep consistent. Skew is a property of deployments that ship
the two separately — a workspace synced into a long-lived runner, a manifest
directory updated under a systemd unit — and those are where the check above
earns its place.

## Mutable tags are a skew you did not choose

An import pinned to a moving tag (`@latest`) is upgraded by whoever publishes
next, not by you. `telo check` revalidates such a ref against the digest it
cached and refetches when the tag moved — so a `check` that passed yesterday can
fail today with `MODULE_REQUIRES_NEWER_RUNTIME`, correctly. Pin exact versions
for anything you deploy; the mutable form is for development.

## See also

- [Declaring runtime requirements](/extend/declaring-runtime-requirements) —
  the grammar, and how the range is verified by execution at publish.
- [Running in production](/deploy/production) — image pinning and the runtime
  environment.
- [Diagnostics reference](/reference/diagnostics) — `MODULE_REQUIRES_NEWER_RUNTIME`
  and `REQUIRES_INVALID`.
