# Ui.Theme

Design tokens.

| Field | | |
| --- | --- | --- |
| `tokens` | required | token values by name |

```yaml
kind: Ui.Theme
metadata: { name: brand }
tokens:
  color.accent: "#1f8fff"
  color.danger: "#c4341b"
  radius.md: 6px
  font.body: !ref inter
```

## Tokens

The set is closed: a name outside it is an error.

| Group | Tokens |
| --- | --- |
| `color.` | `background`, `surface`, `text`, `muted`, `border`, `accent`, `accent-text`, `danger`, `warning`, `success` |
| `radius.` | `sm`, `md`, `lg` |
| `space.` | `xs`, `sm`, `md`, `lg`, `xl` |
| `shadow.` | `sm`, `md` |
| `font.` | `body`, `heading`, `mono` |
| `font-size.` | `sm`, `md`, `lg`, `xl` |
| `line-height.` | `body`, `heading` |

A `font.` token is a `!ref` to a `Font.Family`; every other value is a CSS
value, written as a string. A token left out keeps the renderer's default.

A renderer projects each token to a CSS custom property named
`--telo-<token with dots as hyphens>` — `color.accent-text` is
`--telo-color-accent-text` — and serves a family's faces from its declaration.
