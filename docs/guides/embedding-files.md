---
description: "!include-text and !include-bytes embed a file that ships beside your manifest — fonts, artwork, SQL, prompts — with the path checked statically and the file added to your published artifact automatically."
---

# Embedding files

Some values do not belong in YAML. A brand font, a background SVG, a long SQL
query, a system prompt — each is a *file* that ships next to the manifest, and
pasting its contents (or its base64) into a scalar makes the manifest
unreadable and unreviewable.

Two tags embed a file as a manifest value:

```yaml
kind: PdfMake.Document
metadata: { name: CustomerReport }
fonts:
  Brand:
    normal: !include-bytes assets/Brand-Regular.ttf
background:
  svg: !include-text assets/page-background.svg
```

`!include-text` yields a UTF-8 string. `!include-bytes` yields raw bytes — a
`Uint8Array`, which is exactly what a slot annotated `x-telo-type: Telo.Bytes`
accepts.

## Paths are relative to the module root

Always to the directory holding `telo.yaml` — **never** to the file the tag was
written in, even when that is a partial pulled in through `include:`.

That is the same rule a controller's `path=` qualifier and your `files:`
patterns already follow, and it is the rule that makes a manifest mean one
thing everywhere. Publishing flattens every partial into a single published
`telo.yaml`, so a path measured from the file it was written in would quietly
point somewhere else in the artifact — a module that works in your checkout and
fails for everyone who installs it.

`./` and interior `..` segments fold away, so `./assets/fonts/../logo.svg` and
`assets/logo.svg` are the same file.

## What is checked, and when

**Statically, by `telo check`.** A path that climbs above the module root, an
absolute path, a URL and a glob are all refused. This is decided from the
written path alone — no filesystem is consulted — which is why the editor and
the browser-based analyzer enforce it too:

```
error  !include-text at 'background.svg': '../../etc/hostname' points above the
       module root. An include path may only name a file inside the module,
       since that is the only thing its artifact can carry.
       INCLUDE_PATH_ESCAPES_MODULE
```

`telo publish` additionally refuses to publish when a named file does not
exist, since that would ship an artifact whose manifest reads a file the
payload does not carry.

**At runtime, when the resource is created.** The file is read at the moment the
resource holding it is built — not when the manifest loads. That matters for a
published module: reading a manifest never pulls its payload, so importing a
library whose resources you never instantiate never downloads its assets. A
`with:`-scoped resource pays only when its scope actually runs.

One consequence: an embed only makes sense **inside a resource**. Written on a
`Telo.Application` or `Telo.Library` doc it would never be read, so that is an
error (`INCLUDE_OUTSIDE_RESOURCE`) rather than a silent no-op.

## Publishing picks the files up for you

You do not list embedded files in `files:`. The manifest already names them, so
`telo publish` adds each one to the artifact — the same way it adds a
controller's entry point because `controllers:` names it. They land in the
`assets` layer, which is fetched lazily, so a consumer downloads them only if
something reads them.

## When to use `Fs.File` instead

`!include-*` is for a file that **ships with the module**. Reach for
[`Fs.File`](https://hub.telo.run) when the file does not:

| | `!include-*` | `Fs.File` |
| --- | --- | --- |
| Where the file lives | inside the module | anywhere on the host |
| Path | literal, module-relative | any, computed at runtime |
| Read | once, when the resource is created | per invocation |
| In the published artifact | yes, automatically | no |

A computed path is deliberately not expressible — a file that must ship inside
the artifact has a name that is known when the artifact is built, so the
dynamic case and the artifact case never overlap. When you need to choose
between a few shipped files, embed them all and pick with `!cel`; the set is
closed anyway, since the artifact has to carry every file it might use.

## Limits

A single embedded file is capped at 32 MB, because the value is retained for as
long as the resource holding it. Something larger is a payload to stream, not a
manifest value.

The Rust kernel supports `!include-text` only: it carries a manifest as JSON,
which has no representation for raw bytes, and it says so rather than producing
something a `Telo.Bytes` slot would not accept.

## See also

- [`!ref` and `!cel`](/learn/refs-and-cel) — the other two tags.
- [Diagnostics](/reference/diagnostics) — every `INCLUDE_*` code.
