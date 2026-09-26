---
slug: /learn/editor-telo-version
description: "Which telo version an editor checks your manifests against: Auto picks one per module from requires: telo:, a telo.version pin fixes it, and the chosen version's own engine produces every diagnostic, completion and quick fix."
---

# Editing against a telo version

An editor checks a manifest **against one telo version**. Every diagnostic,
completion, hover, rename and quick fix you see comes from that version's own
engine — the `@telorun/language-server` published with telo `X` — so what the
editor reports is what telo `X`'s `telo check` reports. The status bar says which
version that is: **Telo 0.102.0**.

The editor ships one engine (the bundled version) and fetches others from npm as
modules ask for them. Each fetched engine is verified against its published
`sha512` integrity before it runs, and cached.

## Choosing the version: `telo.version`

| Value | Meaning |
| --- | --- |
| `auto` (default) | A version per module, chosen from its `requires: telo:` ranges — see below. |
| `0.102.0` | Every module is edited against exactly that version (**pinned**). |
| `0.102.0+unreleased` | Pins a development build's engine (see below). |

Run **Telo: Select Telo Version** (or click the status item) to pick from a list:
**Auto** with the version it resolves to, the bundled version, and every
available version newest first — each marked as accepted or refused by the
current module's ranges, and as cached or not. Picking one writes `telo.version`.

In telo studio the setting is per workspace, in the top bar beside the **Telo X** status: pick **Auto** or a version from the list; downloaded engines are kept in the browser's Cache Storage (`telo-engines`).

## How Auto chooses

The choice is made per **module** — a `telo.yaml` and the partials it includes —
from the `requires: telo:` range of the module itself and of every module it
imports ([declaring runtime requirements](../extend/declaring-runtime-requirements.md)):

1. **The module declares `requires: telo:`** — the lowest available version that
   its own range and every imported module's range accept. Declaring a floor says
   "this is what I am verified against", so you edit against exactly that.
2. **The module declares nothing** — the bundled version, as long as every
   imported module's range accepts it; otherwise the lowest available version
   they all accept.
3. **Nothing satisfies them** (the ranges exclude each other, or ask for a telo
   newer than any available one) — the bundled version, whose load gate reports
   `MODULE_REQUIRES_NEWER_RUNTIME` at the module that refuses it. The status says
   that no available telo satisfies the ranges.

A module reopens on the version it last resolved to in that workspace — the
bundled one the first time, or when that version's engine is no longer cached —
and moves once its first analysis names the ranges it has; the switch happens by
itself, a moment after the file opens.

A **pin always wins**. A pin naming a version the editor cannot offer — one that
was never published, one older than the first `@telorun/language-server` release,
or one speaking an editor protocol this editor does not — is shown as an error
naming which; no other version is used instead.

## What is available

The versions offered are the published releases of `@telorun/language-server`
that speak this editor's protocol, plus the bundled one. The oldest you can edit
against is therefore the first telo release that published an engine; earlier
telo versions have none. Prereleases and deprecated releases are not offered.

## Development builds

An editor built from a telo checkout before its release — a local build, or a
deployment of the main branch — ships an engine that implements the coming
release `X` but is not the `X` that will be published. It names itself
`X+unreleased`, and the editor shows it as **Telo X (unreleased build)**. It
counts as `X` for `requires: telo:` (a module declaring `>=X` is satisfied by
it), but it is a different engine from a published `X`: where Auto could pick
either, it picks the published one — except when it keeps the bundled engine
because nothing asks for another — and a pin names one of them exactly
(`0.102.0` or `0.102.0+unreleased`).

## When an engine fails

An engine that crashes, throws while loading or does not start within 30
seconds is an **error state** like the ones below: the status names the version
and why, its modules get no diagnostics or features until **Retry** starts it
again, and no other version is used in its place.

## Offline

The list of versions is cached, and so is every engine once fetched. The editor
starts on that cached list and reads the registry in the background (giving up
after 15 seconds), so a slow or absent network never delays the first
diagnostics. Offline, the editor offers the last cached list — or only the
bundled version if it never reached the registry — and runs any cached engine. A version that is neither
cached nor downloadable is an **error state**: the status item and one
notification name it, with **Select version** and **Retry**. The editor never
quietly edits against a different version instead.

## Running is unaffected

The editing version only decides what the editor checks against. `telo run`
runs your installed telo, whatever the editor shows; a module that needs a newer
runtime than that is reported by the runtime's own load gate.
