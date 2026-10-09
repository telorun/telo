---
sidebar_label: Telo Studio
slug: /build/studio
description: A web and desktop editor for authoring Telo manifests visually — topology canvas, resource inventory, raw YAML, and an integrated runner.
---

# Telo Studio

Telo Studio is a web and desktop application for authoring and running Telo manifests. It opens a workspace directory, parses every `telo.yaml` and `Telo.Application` it finds, runs the same static analysis the [CLI's `telo check`](/learn/installation-and-cli) uses, and exposes four coordinated views over the same underlying model.

**Open it at [studio.telo.run](https://studio.telo.run)** — it runs in the browser, with a desktop build for local workspaces.

Studio never owns a hidden representation: the YAML on disk is the source of truth, and every view edits it directly. Diagnostics shown in studio match exactly what the kernel will accept at boot.

## The four views

| View | What it shows |
| --- | --- |
| **Topology** | The resource graph — every `!ref` as an edge, so you can see what calls what and what a change reaches. |
| **Inventory** | Every resource in the workspace as a list, grouped by kind. The fastest way to find a declaration or add one. |
| **Source** | The raw YAML, with the same diagnostics the CLI reports, inline. |
| **Deployment** | Runs the manifest in a container and streams its logs back (below). |

They are views over one model, not separate editors: a rename in Inventory moves the edges in Topology and rewrites the YAML in Source.

## Workspaces

A workspace is any directory containing one or more `Telo.Application` or `Telo.Library` files. Studio walks the tree, resolves each entry in every manifest's `imports:` map, and presents every resource it finds.

Module documentation (schema descriptions) is rendered inline next to each field, so authors don't need to context-switch to a docs site to know what a property does.

## Telo Cloud projects

Signing in is optional: everything above works without an account. Where Studio
is served by Telo Cloud, and in the desktop build, **Sign in** adds **Open from
Telo Cloud**, which lists your Cloud projects.

Opening one copies its git repository to your device as a working copy, on the
project's default branch. You edit, run and use the agent exactly as in any
other workspace, and nothing reaches Cloud until you commit. The strip above the
tabs shows the project, its branch and how many files have changed.

| Action | What it does |
| --- | --- |
| **Commit** | Lists the changed files, asks for a message, and commits them to the branch as you. |
| **Update** | Offered when the branch has new commits and you have local changes. Files only the branch changed are taken; a file both sides changed is yours to settle with **Keep mine** or **Take theirs**. Nothing is committed by an update. A working copy with no local changes follows the branch by itself. |
| **Publish** | Publishes the open Application or Library at the last commit to your project's private registry and shows its ref, version, digest and integrity pin. Enabled once the module's directory has nothing uncommitted. It creates no app and starts no deployment — do that in the Telo Cloud console with the ref. |
| **Published modules** | What the project has published, with each module's versions. A project admin can make a module public or private. |

A project you can only view opens read-only: you can run it, not edit, commit
or publish. If the git host protects the branch, Studio offers to commit to a
new branch instead. Projects, members and repository connections are managed
in the Telo Cloud console.

Signing out removes the working copies from the device, after listing the
projects whose changes were never committed.

## Hosting the web build

Each Studio release publishes the web build as the image
`ghcr.io/telorun/studio-web:<version>` and a Helm chart for it:

```
helm install studio oci://ghcr.io/telorun/charts/studio-web --version <version> \
  --set httpRoute.enabled=true \
  --set 'httpRoute.parentRefs[0].name=<gateway>' \
  --set 'httpRoute.hostnames[0]=studio.example.com'
```

The image is static files: it holds no credentials and no state. `ingress.*`
is the equivalent for a cluster without Gateway API, and `image.digest` deploys
by digest instead of by tag.

Studio reaches Telo Cloud through `/api` on its own host, which this image does
not serve. To offer sign-in, route `/api` on the same host to the Telo Cloud
API; the chart's route takes everything else. On a host with nothing behind
`/api` Studio works as before, with the Telo Cloud controls hidden.

## Open a manifest by link

The web build opens a manifest named by the `open` query parameter:

```
https://studio.telo.run/?open=<location>
```

Studio shows what it is about to copy and asks before writing anything. On
confirmation the manifest is copied into the browser's workspace as
`/workspace/apps/<slug>/telo.yaml`, where `<slug>` is the kebab-case form of its
`metadata.name`, and the parameter is removed from the address bar so a reload
does not open it again. An Application and a Library open the same way. The
desktop build does not read the parameter.

`<location>` is one of two forms.

### An `https://` URL

```
https://studio.telo.run/?open=https://example.com/apps/hello/telo.yaml
```

The manifest is fetched directly, so its host must allow cross-origin requests.
Its relative imports and `include:` partials on the same origin are copied beside
it at the same relative paths, and the literal paths its `files:` lists are
fetched too; a glob in `files:` is reported rather than expanded.

### A pinned published ref

```
https://studio.telo.run/?open=oci%3A%2F%2Fghcr.io%2Facme%2Fhello-app%400.1.0%23sha256-viMWXJ7B89yRyqL4NaGWZVtFkOg8QPzlJb2UFwz7YeA
```

The value is `encodeURIComponent("oci://<host>/<repo>@<version>#sha256-<pin>")`.
At minimum the `#` must be written `%23`: left bare, it ends the query and the
pin becomes the page's fragment.

A browser cannot read an OCI registry, so the manifest is read through the hub's
manifest cache (`https://manifests.telo.sh`, or the manifest cache URL set in
Studio's settings) — the same place Studio resolves `oci://` imports from. The
cache holds only versions a hub has ingested, so the version must be
[registered with a hub](/guides/distributing-an-application#register-with-the-hub)
first. The bytes read are verified against the pin before anything is shown, and
written unchanged.

The copy holds the manifest alone. The confirmation lists the payload layers the
manifest's `layers:` index declares — controllers, libraries, native files,
assets — none of which are copied; with no `layers:` index there is nothing to
list. Imports are not copied either: they resolve from the copy like any other
import in the workspace.

A ref that cannot be opened is refused with one of these messages:

| Message | Meaning |
| --- | --- |
| `Studio opens a published application only by version and pin: oci://<host>/<repo>@<version>#sha256-<pin>` | The ref has no `@<version>` or no `#sha256-<pin>`. A tag without a pin can be moved, so Studio does not open one. |
| `` the pin arrived as the page fragment — percent-encode `#` as `%23` `` | The ref has no pin, but the page URL's fragment starts with `sha256-`: the link was written with a bare `#`. |
| `<cache URL> has no copy of <ref>@<version> (HTTP 404). …` | The manifest cache does not hold that version (a `404` or `410`). Register the repository with the hub and open the link again once the hub reports it `ready`. |
| `Integrity check failed for <ref>: expected <pin>, got <pin>. …` | The cache served bytes whose hash is not the pin — the same refusal `telo run` gives. |

Any other failure — the cache unreachable, a server error — is shown as the
loader reports it.

## Running manifests from studio

The Deployment view runs your manifest in a Docker container and streams logs back into studio. The container can live on your machine or any reachable host, so the same setup that works locally also drives a remote staging box.

It is the same Docker loop you'd use in production — see [Deploy with Docker](/deploy/docker). Studio just packages and ships the manifest for you on every "Run".
