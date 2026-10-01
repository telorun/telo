---
description: "Publish a Telo application to an OCI registry, attach your own annotations, understand why a published version's pin never moves, and run the application by its pinned ref."
---

# Distributing an application

An application is published the way a library is: as an OCI artifact, one
version per `metadata.version`, and run by anyone straight from the registry.

```sh
telo publish oci://ghcr.io/acme/hello-app ./telo.yaml
telo run oci://ghcr.io/acme/hello-app@0.1.0#sha256-viMWXJ7B89yRyqL4NaGWZVtFkOg8QPzlJb2UFwz7YeA
```

## Publishing

`telo publish <destination> <manifest>` checks the manifest, verifies every
import pin against its registry, builds the payload and pushes it under the tag
`metadata.version`. The destination names a full repository
(`oci://<host>/<org>/<name>`). `--dry-run` runs every check and prints what
would be pushed, without pushing.

The artifact's OCI manifest carries the standard annotations, written from the
module's own `metadata`:

| Annotation | From |
|---|---|
| `org.opencontainers.image.title` | `metadata.name` |
| `org.opencontainers.image.version` | `metadata.version` |
| `org.opencontainers.image.description` | `metadata.description` |
| `org.opencontainers.image.source` | `metadata.repository` |
| `org.opencontainers.image.licenses` | `metadata.license` |
| `org.opencontainers.image.documentation` | `metadata.documentation` |

## Your own annotations

`--annotation <key>=<value>` adds an annotation of your own. Repeat it for more:

```sh
telo publish oci://ghcr.io/acme/hello-app ./telo.yaml \
  --annotation com.example.note="internal preview" \
  --annotation com.example.team=platform
```

- The flag is split at its first `=`, so a value may contain `=`.
- The key is a reverse-domain name: two or more dot-separated segments of
  letters, digits, `-` and `_`, each starting and ending with a letter or digit.
- A key given twice is refused.
- A key from the table above is refused, whether or not your manifest declares
  that field — set the `metadata` field instead, which is what the refusal names.
- Each annotation is written onto every OCI manifest the invocation pushes.
- The pushed set is the derived annotations plus exactly this invocation's.
  Republishing a version **replaces** the annotations it carried; nothing is
  merged, so pass every annotation you want to keep.
- `--dry-run` prints the full set that would be pushed, and `-o json` reports it
  per manifest under `annotations`.

The keys are checked before anything is built or fetched. Annotations are
descriptive only: the pin does not cover them and nothing resolves a module by
them.

## A published version's pin never moves

A consumer pins a version by the hash of its `telo.yaml` — the `#sha256-…` after
the version. So once a version is published, its `telo.yaml` is fixed:

- Publishing the **identical** `telo.yaml` again succeeds, and keeps the pin. This
  is how annotations are changed on an existing version.
- Publishing a **different** `telo.yaml` at the same `metadata.version` is
  refused, including under `--dry-run`. The refusal names
  `<destination>@<version>`, the published pin and the pin of what was just
  built, and then either each payload layer whose contents moved, or — when none
  did — that the manifest itself changed (its metadata, its imports, or how this
  telo serializes it). Editing a description is enough to change the pin.

The remedy is always a new version: raise `metadata.version` and publish again.
In a release workspace, `telo release status` shows what would bump and
`telo release apply` moves it.

The comparison reads the published `telo.yaml` from the registry itself. A
version that is not published yet passes; any other registry failure fails the
publish, because it leaves the question unanswered.

## What a registry or launcher learns about your application

`telo module manifest <ref> --json` reports an application's declared inputs
under `application` (and `null` for a library): its `variables`, `secrets` and
`ports` in declaration order, each with its `name`, `description`, whether it is
`required` (it declares no `default:`) and the `env` variable that sets it.
Variables and ports also carry their `default` and their command-line `arg`
binding; variables carry their remaining JSON Schema keywords as `schema`; ports
carry their `protocol`. A secret carries only its `type`, never a default,
example or allowed value.

## Running by pinned ref

```sh
telo run oci://<host>/<repo>@<version>#sha256-<pin>
```

The ref is the manifest path, so every token after it is the application's own
argument, exactly as with a local file. The root `telo.yaml` is fetched and
verified against the pin **before anything boots** — a mismatch stops the run
before any resource is created, naming the ref, the expected pin and the pin of
what was served. The same check applies when the manifest comes from the
`.telo/manifests` cache instead of the network.

An unpinned ref (`oci://<host>/<repo>@<version>`) runs **unverified**: the tag is
mutable, so what runs is whatever the registry serves under it today. Publish the
pinned form. `telo publish` does not print the pin;
`telo module manifest oci://<host>/<repo>@<version> --json` reports it as
`integrity`.

Imports are verified the same way, each against the pin its manifest records, and
each module's payload layers against the `layers:` index in its verified
`telo.yaml`.

## Register with the hub

The [hub](https://hub.telo.run) indexes a published application by its ref, as
it indexes a library. Register it once — the form on hub.telo.run, or the open
endpoint directly:

```sh
curl -X POST https://telo.sh/register \
  -H 'content-type: application/json' \
  -d '{"ref": "oci://ghcr.io/acme/hello-app"}'
```

The ref names the repository, not a version: the hub enumerates the versions
itself, answers `202`, indexes the latest version in the background and picks up
every later one on its own. `GET https://telo.sh/register/status?ref=…` says when
it is `ready`.

What the hub indexes for an application is its `metadata` — `description` is
its search text and `categories` its facet, exactly as for a library — and its
declared contract: every `variables:`, `secrets:` and `ports:` entry, as
`telo module manifest --json` reports it. No value of a secret is indexed. Its
own kinds are not offered as importable, and its runtime reach is not indexed,
because that depends on its whole import closure.

Search offers applications only when asked, since a search is usually made by
someone composing a manifest and an application cannot be imported:

```sh
curl 'https://telo.sh/search/resources?q=greeting&entry=application'
```

The MCP tool `search_resources` takes the same `entry` argument. An application
hit carries its contract as `application`; `GET /module?ref=…` (and the MCP
tool `get_module`) returns it for any tracked version, and
`GET /module/versions?ref=…` (`list_module_versions`) lists every version with
the pin to run it by.

The hub serves no file an artifact ships — no README, no images, no payload. It
caches the `telo.yaml` alone; a file the application carries is read from the
artifact at its pinned ref and verified against the `layers:` index the pin
covers.

## Open in Studio

Once the hub reports a version `ready`, a link opens it in the web build of
[Telo Studio](/build/studio):

```
https://studio.telo.run/?open=<encodeURIComponent("oci://<host>/<repo>@<version>#sha256-<pin>")>
```

The `#` before the pin must be encoded as `%23`. Studio reads the manifest
through the hub's manifest cache, verifies it against the pin, and copies the
manifest alone into the browser's workspace — its payload layers stay in the
registry. The link's form and each refusal are documented under
[Open a manifest by link](/build/studio#open-a-manifest-by-link).

## What the Rust build can run

The `telo` built from `cli/rust` loads and verifies a pinned root the same way,
and refuses a tampered pin the same way. What it cannot do is host most
applications once they are loaded, because its kernel is deliberately narrow:

- An Application declaring `variables:`, `secrets:` or `ports:` is refused
  (`ERR_UNSUPPORTED_MANIFEST_FEATURE`) — the Rust kernel does not implement
  application inputs yet. So is one using `include:`, `lifecycle:` or
  `tracing:`, or whose `targets:` are anything but inline invoke steps without
  `when:`.
- It hosts only controllers it can open: `pkg:telo/local/dylib` from a published
  artifact and `pkg:cargo` built from a source checkout. A kind delivered only as
  a JavaScript bundle (`pkg:telo/local/js`), which is most of the standard
  library, fails with `ERR_CONTROLLER_NOT_FOUND`.
- It has no CEL.

These are refusals, not silent differences, and they are owed rather than
designed. The Rust build also does not publish: `telo publish` exists only in the
Node build.
