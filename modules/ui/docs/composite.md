# Ui.Composite

The contract a piece of interface with its own configuration provides through.
An abstract: `Ui.View`, `Ui.Table`, `Ui.Form`, `Ui.Action`, `Ui.Filters` and
`Ui.Component` extend it, and so can a kind of your own.

A composite provides:

| Field | |
| --- | --- |
| `node` | the `Ui.SpecNode` to draw. Optional: a composite with nothing to show provides none, and whoever placed it leaves it out, exactly like a node whose `when` is false. |
| `assets` | the files a browser must load for it: `{ digest, name, file, mediaType }` each, where `digest` is the hex SHA-256 the file is addressed by, `name` its path below that, and `file` its absolute path on the host. |

## A composite with no controller

A templated kind provides through a view, so a library ships a ready section
with no code:

```yaml
kind: Telo.Definition
metadata: { name: Banner }
capability: Telo.Provider
extends: Ui.Composite
schema:
  type: object
  required: [heading]
  properties:
    heading: { type: string }
resources:
  - kind: Ui.View
    metadata: { name: view }
    content:
      type: stack
      children:
        - { type: text, text: !cel "self.heading", style: heading }
provide: !ref view
```

An application then places `{ type: composite, ref: { kind: Banners.Banner, heading: Hello } }`.

## For a renderer's controller: `@telorun/ui`

A module that imports this one can import its code entry, `@telorun/ui`, from
its own controller. Its surface is one function and the two shapes it speaks:

| Export | |
| --- | --- |
| `entryAssets(entry)` | Turns a built browser entry — what `ctx.resolveBrowserEntry` / `ctx.resolveControllerBrowserEntry` return — into `{ module, assets }`: the entry file and every file built beside it as `assets`, and the entry's own address as `module`. |
| `AssetFile` (type) | One file of `assets`: `{ digest, name, file, mediaType }`, as in the table above. |
| `AssetRef` (type) | An address, `{ digest, name }`. |

What `entryAssets` decides:

- **`digest`** — one for the whole entry: the hex SHA-256 of the entry's own
  build digest. Every file of the entry sits under it.
- **`name`** — each file's path below the deepest directory that holds all of
  them, with `/` separators, so an entry still reaches its chunks by the
  relative paths it was built with.
- **`mediaType`** — from the extension: `.js` and `.mjs` are `text/javascript`,
  `.css` is `text/css`, `.map` is `application/json`, anything else
  `application/octet-stream`.

A placed component's files are addressed by this function, so a renderer that
passes its own entries through it serves both under one scheme:

```ts
import { entryAssets } from "@telorun/ui";

const entry = await ctx.resolveControllerBrowserEntry("@acme/renderer");
const { module, assets } = entryAssets(entry);
```

The function reads no file. `file` is where the bytes are on this host; whoever
serves them reads them.
