# Ui.DesignTokens

An interface's brand: its colours, radii, spacing, shadows, type sizes and
typefaces, by name. It says nothing about how anything is drawn — a renderer's
theme reads the tokens, so one token set works under any theme, and changing
the theme keeps the brand.

Each token is a field of the resource itself:

```yaml
kind: Ui.DesignTokens
metadata: { name: brand }
color.accent: "#1f8fff"
color.danger: "#c4341b"
radius.md: 6px
font.body: !ref inter
```

## Tokens

The set is closed: a name outside it is refused (`SCHEMA_VIOLATION`), so a
misspelled token never silently does nothing.

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
value, written as a string. A token left out keeps the theme's value.

The names are also code: the module's code entry `@telorun/ui` exports them as
`DESIGN_TOKENS`, spelled as above, for whatever reads a token set by name — a
check that a theme gives every token a value reads them there rather than
copying the list. A unit test holds the export equal to the kind's schema.

A renderer projects each token to a CSS custom property named
`--telo-<token with dots as hyphens>` — `color.accent-text` is
`--telo-color-accent-text`, the spelling `ui-react` exports as `tokenProperty`
from its `@telorun/ui-react-contract` entry — and serves a family's faces from
its declaration.

## Where a token set is used

`ui` declares the vocabulary only. With `ui-react`, a token set is a theme's
defaults (`UiReact.Theme.tokens`) or an application's brand
(`UiReact.App.tokens`, one set or a list chosen per request); see
[the application](../../ui-react/docs/app.md#look) and
[themes](../../ui-react/docs/theme.md).
