# Icons

An icon is a resource: a single-colour glyph that provides one image file. A
navigation entry declares one in place or names one by reference, and a renderer draws it in the colour
of the text around it, so a theme colours an icon as it colours text — the
current entry's glyph takes the current entry's colour with no rule of its own.

## `Ui.Icon`

The abstract every source of glyphs extends. What it provides:

| Member | |
| --- | --- |
| `file` | the image the glyph is drawn from, an absolute path on the host running the application: an SVG, PNG or WebP file whose opaque pixels are the glyph's shape |

Each source of glyphs is a kind of its own: `Ui.FileIcon` for a file of your
own, and an icon set's kind for its named glyphs —
[`UiLucide.Icon`](../../ui-lucide/README.md) for the Lucide set. A kind of
another module extending `Ui.Icon` is accepted wherever an icon goes, with no
change to `ui`.

## `Ui.FileIcon`

```yaml
kind: Ui.FileIcon
metadata:
  name: mark
file: !module-path ./icons/mark.svg
```

| Field | | |
| --- | --- | --- |
| `file` | required | the image file, a `Telo.HostPath` naming a file: `!module-path` for one that ships with the module, or a host-path variable |

A brand mark, or a symbol no icon set has. Only the file's shape counts:
whatever colours it holds are replaced by the colour of the text beside it.

## How a renderer draws one

`ui` hands a renderer's controller each icon's `file`; the renderer serves it
under its content digest and draws it as a mask over the text's colour, never
inserting the file's markup into the page. `ui-react` serves an SVG, PNG or
WebP file and refuses any other with `ERR_UI_ICON_FORMAT_UNKNOWN` when the
application starts — see [the application](../../ui-react/docs/app.md#icons).
