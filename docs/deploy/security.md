---
sidebar_label: Security & supply chain
slug: /deploy/security
description: What a Telo module can reach on your host, how import pins and layer digests are verified end to end, how secrets are handled, and how to lock down egress.
---

# Security & supply chain

A Telo application is mostly other people's code: every `kind:` you write is
implemented by a controller that came from a module you imported. This page is
the honest account of what that means — what is verified, what is isolated,
what is not, and what you can turn on.

## The trust model, stated plainly

**Controllers are not sandboxed.** A module's controller runs in the same
process as the kernel, with the full privileges of the user running `telo`. It
can open sockets, read and write files, and spawn processes, whether or not the
kind it implements suggests any of that. There is no capability gate on a
controller today.

The consequence is the rule that should drive your review process:

> Importing a module is equivalent to adding a dependency you execute — treat a
> new import with the same scrutiny as a new `npm install` in a service that
> holds production credentials.

What Telo does give you is a **strong integrity story** — you can guarantee that
the bytes you audited are the bytes that run — plus a small number of runtime
guardrails described below. A default-deny capability sandbox (`grants:` on an
import) is specified but **not implemented**; do not design around it yet.

## Integrity: from the pin to the bytes

Every hop from your manifest to executed code is content-addressed, and each
link verifies the next.

**1. The import pin.** A remote import may carry a `#sha256-…` fragment:

```yaml
imports:
  Http: oci://ghcr.io/telorun/http-server@0.22.0#sha256-1xIdKfDZ_KTlJuI57v2ADUT45nUsVAfk1nQA_kZYvFY
```

The fetched bytes are hashed and compared against the fragment **before the
manifest is parsed or cached**. A mismatch is terminal — never downgraded to a
cache miss, never retried against another source. The fragment is authoritative
across every transport, so the same pin protects an OCI ref, a registry ref, and
a plain HTTPS URL alike.

`telo upgrade` maintains these pins for you: it rewrites the version and drops
the now-stale hash, so a pin never silently describes a different version than
the ref beside it.

**2. The layer index.** A published module is an artifact of several layers —
the manifest, one controller layer per platform, assets, and everything else.
The pinned `telo.yaml` carries a `layers:` index naming, per layer, both its OCI
blob digest and a framing-independent content digest. That is what extends the
chain past the manifest:

```
import pin → telo.yaml → layer blob digest → layer contents
```

A layer whose contents do not hash to its recorded `integrity` fails with
`ERR_MODULE_LAYER_INTEGRITY` at materialization. Layers are addressed through
this index rather than through the registry's layer list, so a republish that
reorders or re-tags layers cannot substitute one.

**3. Immutability of the ref itself.** A registry version is immutable by
convention, and `telo check` serves it from cache without revalidation. A
**mutable OCI tag** (`@latest`) is exactly what it sounds like: `check`
revalidates it with a `HEAD` against the digest recorded in
`.telo/manifests/.origins.json` and refetches when it has moved. Pin exact
versions — plus the `#sha256-` fragment — for anything you deploy.

**4. Publishing.** `telo publish` refuses to push changed bytes at an unchanged
`metadata.version`, comparing each layer's digest against what is already
published. A module version cannot quietly acquire new contents.

## Reproducible, offline deployment

`telo install` resolves the whole import graph and every controller into
`<manifest-dir>/.telo/`. Run it in your build stage, ship the directory with the
manifest, and the production process performs **zero network I/O at boot** — so
a compromised or unavailable registry cannot affect a running deployment, and
what you audited in CI is byte-for-byte what starts in production.

Add `--platform os/arch[/libc]` when the build machine differs from the target,
so the right controller layers are baked in.

## Egress control

Module refs are attacker-suppliable once you accept modules from a public index,
so the fetch path can be restricted:

```bash
TELO_EGRESS=public-only telo install ./manifest.yaml
```

With `public-only`, any fetch to a host that is — or resolves to — a private,
loopback, or link-local address is refused. This is an SSRF guard on **module
resolution**, not a general network policy: it does not constrain what a running
controller does with a socket. For that, use your own network policy
(Kubernetes `NetworkPolicy`, a firewall, an egress proxy).

## Secrets

Secrets are declared on the `Telo.Application` and bound from host environment
variables:

```yaml
secrets:
  databaseUrl:
    env: DATABASE_URL
    type: string
```

Three properties follow:

- **They are typed and validated at load.** A missing required secret fails the
  whole load with `ERR_MANIFEST_VALIDATION_FAILED` before any controller
  initializes — not at the first request that needed it.
- **They are redacted in logs automatically.** Every value bound to `secrets:`
  is redacted with no configuration. Additional paths (an `authorization`
  header, a nested token) are named explicitly under `logging.redact.paths`,
  and bad paths are caught by `telo check`. See [Logging](/build/logging).
- **They are not readable from the ambient environment.** Once a name is
  declared, the kernel replaces `process.env` with a guardrail proxy under
  which that key reads back `undefined`, with a warning. A controller cannot
  bypass a declared binding by reading the raw environment. This is a
  **guardrail against accidental bypass, not isolation** — it constrains
  well-behaved code, and undeclared variables pass through untouched.

Child modules never see the host environment: only the root Application binds
env vars, and it forwards values explicitly into imports. A library cannot
declare an `env:` key at all (`LIBRARY_ENV_KEY_REJECTED`).

Telo does not integrate with a secrets manager directly. Inject values the way
your platform already does — a Kubernetes `Secret` mounted as env vars, an ECS
task-definition secret, systemd `EnvironmentFile`, or a wrapper that fetches
from Vault and `exec`s `telo`.

## Reviewing a module before you import it

1. **Read its manifest** — `telo module manifest <ref>`, or the module's page on
   [hub.telo.run](https://hub.telo.run). The `Telo.Definition` docs are the
   complete public surface, and `controllers:` names exactly what will be
   executed.
2. **Check where the controller comes from.** `pkg:telo/local/js` means it ships
   inside the module's own artifact, covered by the layer digests above.
   `pkg:npm/...` means an npm package is fetched at install time — a second
   supply chain, with its own transitive dependencies.
3. **Pin it** — exact version plus `#sha256-`.
4. **Re-run `telo check` in CI.** It resolves imports and verifies pins, so a
   moved dependency fails the build rather than the deploy.

## What is not there yet

Stated explicitly so nothing is designed around a promise:

- **No controller sandbox / capability grants.** The `grants:` spec is a draft.
- **No artifact signing or provenance attestation.** Integrity is verified
  against a hash *you* pinned; there is no publisher signature to verify it
  against.
- **No SBOM generation.**
- **No vulnerability scanning of module dependencies.**

Scan the container image you build and pin your imports; those are the controls
that exist today.

## See also

- [Running in production](/deploy/production) — lifecycle, signals, env vars.
- [Docker image](/deploy/docker) — cache warming and image variants.
- [Module system](/reference/kernel/modules) — refs, transports, and how
  publisher namespaces work.
