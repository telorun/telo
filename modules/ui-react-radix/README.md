# UI React Radix

A theme for [`ui-react`](../ui-react/README.md): Studio's look over every part
the renderer draws, with its selects, multi-selects, option lists, checkboxes,
dialogs, drawers, popovers, confirmations, menus, tooltips and icons drawn by
[Radix](https://www.radix-ui.com/primitives)'s primitives and
[Lucide](https://lucide.dev)'s icons. An application picks it with one
reference; its brand stays its own.

## Why use this

- **One line to switch.** `theme: !ref Radix.theme` on a `UiReact.App`
  restyles every screen and draws its lists, menus and overlays through Radix,
  with no other edit: pages, forms, validation and saved values are the same
  under any theme.
- **A brand on top.** The application's `tokens:` apply over the theme's own
  values, light and dark, so a colour or a radius changes everywhere at once.
- **A base for a look of your own.** A theme in another module can take this
  module's controls whole — `controls: [!ref Radix.controls]` — and give them a
  stylesheet of its own.
- **Held to the renderer's contract.** Its tests run
  [`ui-react-conformance`](../ui-react-conformance/README.md): every part
  styled, no reserved layout property set, every design token given a value
  and read, every screen drawn with its controls, every control's behaviour
  vectors met.

## Resources

| Resource | Is |
| --- | --- |
| [`Radix.theme`](docs/theme.md#the-theme) | A `UiReact.Theme`: the look, the brand's defaults, and the controls below. |
| [`Radix.controls`](docs/theme.md#the-controls) | A `UiReact.Controls` set: `Select`, `MultiSelect`, `Listbox`, `Checkbox`, `Dialog`, `Drawer`, `Popover`, `Confirmation`, `Menu`, `Tooltip`, `Icon`. |

## Example

```yaml
kind: Telo.Application
metadata: { name: Console, version: 1.0.0 }
imports:
  Http: oci://ghcr.io/telorun/http-server
  Ui: oci://ghcr.io/telorun/ui
  UiReact: oci://ghcr.io/telorun/ui-react
  Radix: oci://ghcr.io/telorun/ui-react-radix
targets: [!ref server]
---
kind: UiReact.App
metadata: { name: console }
title: Reports
words: !ref Ui.words
theme: !ref Radix.theme
tokens: { kind: Ui.DesignTokens, color.accent: "#1d4ed8" }
pages:
  - path: /
    title: Reports
    children:
      - { type: text, text: Monthly reports, style: heading }
---
kind: Http.Server
metadata: { name: server }
listen: { port: 8080 }
mounts:
  - { path: /, mount: !ref console }
```

## Docs

- [The theme and its controls](docs/theme.md) — what it styles, which controls
  it draws and how they compose, and how another theme builds on them.
