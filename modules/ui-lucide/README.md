# UI Lucide

The [Lucide](https://lucide.dev) icon set for declarative user interfaces:
every glyph of the set as an icon resource a navigation entry names. A glyph is
named as Lucide names it, and a name outside the set is refused by
`telo check` before the application runs.

## Why use this

- **Checked names.** `name` is a closed list of the set's glyphs, so a typo is
  an error on its own line rather than an empty square in a menu.
- **Drawn like text.** A renderer paints the glyph's shape in the colour of the
  text beside it, so the current entry's icon takes the current entry's colour
  and a theme needs no rule for icons.
- **Nothing extra to install.** The glyphs ship with the module; an
  application reads only the files it names.

## Kinds

| Kind | Purpose |
| --- | --- |
| [`UiLucide.Icon`](docs/icons.md) | One glyph of the Lucide set, named as Lucide names it, provided as its SVG file. |

## Example

```yaml
kind: Telo.Application
metadata:
  name: Admin
imports:
  Ui: oci://ghcr.io/telorun/ui
  UiReact: oci://ghcr.io/telorun/ui-react
  UiLucide: oci://ghcr.io/telorun/ui-lucide
---
kind: UiLucide.Icon
metadata:
  name: homeIcon
name: house
---
kind: UiReact.App
metadata:
  name: admin
title: Admin
words: !ref Ui.words
theme: !ref UiReact.defaultTheme
pages:
  - !ref home
navigation:
  items:
    - { type: page, page: !ref home, icon: !ref homeIcon }
```

## Documentation

- [Glyphs and how they are served](docs/icons.md)
- [Icons in `ui`](../ui/docs/icons.md)
