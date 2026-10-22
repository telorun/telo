# The checks

Both kinds are invocables taking no inputs and answering `{ problems }`, a
list of `{ check, subject, message }` — the named shape
`UiReactConformance.Problem`. An empty list means the theme or the set meets
the contract; a test asserts it with `Assert.Equals`.

## CheckTheme

```yaml
kind: Conformance.CheckTheme
theme: !ref Acme.theme
unstyled:
  - { part: table-detail, reason: "the renderer's layout is the whole look" }
```

| Field | | |
| --- | --- | --- |
| `theme` | required | the `UiReact.Theme` checked |
| `unstyled` | | parts the theme deliberately leaves to the renderer's layout, each with its reason |

It draws every scene of the contract with the renderer and the theme's control
sets, records every element after every step, and judges the theme's
stylesheets and its sets' stylesheets against what was drawn:

1. **Every part is styled.** A part counts as styled when a rule with at least
   one declaration matches it and does not match every element carrying a part,
   so `* { … }` and `[data-telo-part] { … }` style nothing. A rule counts in any
   state: `:hover`, `:active`, `:focus`, `:focus-visible`, `:focus-within` and
   pseudo-elements are taken out of its selector before it is matched; inside
   `:not(…)` a selector that held one of them is dropped. A nested rule is
   matched as its full selector, and rules under `@media`, `@supports`,
   `@layer` and `@container` count. A part neither styled nor listed in
   `unstyled` is `part-unstyled`.
2. **`unstyled` is current.** An entry naming a part the theme does style, or
   naming no part, is `unstyled-stale`.
3. **No reserved property is set.** A rule matching a part that declares one
   of the part's [reserved properties](../../ui-react/docs/styling.md#reserved-properties)
   — directly, through a shorthand (`inset`, `overflow`, `grid`, `all`) or
   through its logical name (`inset-block-end`, `min-block-size`) — is
   `property-reserved`.
4. **Every design token has a default.** Each name of the closed token set —
   read from `ui`'s `@telorun/ui` code entry (`DESIGN_TOKENS`) — is given a
   value by the theme's own `tokens`, or its custom property (spelled by
   `ui-react`'s `tokenProperty`, `color.accent` → `--telo-color-accent`) is
   declared in a `:root` rule of the theme's stylesheets, at the top level or
   inside `@layer`; a `:root` rule under `@media` or `@supports` is a
   variant, not a default. A token with neither is `token-default-missing`.
5. **Every design token is read.** Some `var()` of the theme's stylesheets —
   a fallback inside another `var()` included — reads the token's custom
   property; a token nothing reads is `token-unread`, since a brand setting it
   would change nothing.

A stylesheet the parser cannot parse, or a selector the window cannot match, is
`stylesheet-unparseable`. A scene whose own expectations fail while drawn with
the theme's controls is `scene-failed`; and each of the theme's sets is checked
as `CheckControls` checks it.

The scenes are what catch controls that work alone and fail together. Every
layer on a page comes from one implementation — a set implementing any of the
eight [layer controls](../../ui-react/docs/controls-abi.md#layers) implements
all of them, which `ui-react` refuses otherwise (`UI_CONTROLS_LAYERS_PARTIAL`)
— so what the scenes hold is how that one stack composes: a list opened in a
dialog, a drawer or a popover, the confirmation over a dialog or a drawer, the
menu in a filter overlay, a tooltip over a surface, Escape closing only the
top layer, and a press outside reaching the layers beneath the top one as far
as the first shielding layer
([composition within the stack](../../ui-react/docs/controls-abi.md#layers)).

## CheckControls

```yaml
kind: Conformance.CheckControls
controls: !ref Acme.controls
```

Every vector of every control the set implements is run against the set's own
component: the exact intents and values it reports, where the focus is after
each step, the semantics forwarded to the element carrying `id`, only its
documented parts and states, its overlay drawn outside the application in a
layer whose root carries `data-telo-layer`, a modal one trapping Tab and
returning the focus, closing only through `onOpenChange` with its reason. A vector that fails is `vector-failed`; a set whose entry does
not load, or lacks a control it implements, is `controls-load-failed`.

## Problems

| `check` | `subject` | Means |
| --- | --- | --- |
| `part-unstyled` | the part | no rule of the theme styles it, and `unstyled` does not list it |
| `unstyled-stale` | the part | `unstyled` lists a part the theme styles, or no part at all |
| `property-reserved` | `<part>: <property>` | a rule matching the part sets a property the renderer's layout depends on |
| `token-default-missing` | the token's dotted name | neither the theme's `tokens` nor a `:root` rule of its stylesheets gives the token a value |
| `token-unread` | the token's dotted name | no `var()` of the theme's stylesheets reads the token |
| `stylesheet-unparseable` | the stylesheet's absolute path | it does not parse, or one of its selectors cannot be matched |
| `vector-failed` | `<Control>: <vector>` | the control does not meet that behaviour vector; the message gives each failed step |
| `scene-failed` | the scene's name | a scene breaks while drawn with the theme's controls |
| `controls-load-failed` | the set (`UiReact.Controls '<name>'`) | its entry did not load, or does not export a control it implements |

`CheckControls` answers only `vector-failed` and `controls-load-failed`.

## The window

Each check runs in a worker of its own, re-entering this module's bundle, and
the worker is stopped once it answers. The worker opens a
[happy-dom](https://github.com/capricorn86/happy-dom) window — the version the
workspace pins once, the same one `ui-react`'s own tests prove the built-ins in,
so the DOM implementation and its version are part of the oracle — and stages
the built entries it loads in a directory of its own, removed when it is done:

- `ui-react`'s four React entries, once, so the renderer and every set bind
  one React;
- the renderer, beside generated packages supplying `react`,
  `react/jsx-runtime`, `react-dom` and `react-dom/client`;
- each set's entry, beside generated packages supplying exactly what
  `ui_react_controls-1` supplies — `react`, `react/jsx-runtime`, `react-dom` —
  so an entry reaching anything else, `@telorun/ui-react` included, does not
  load.

The renderer loads each set through its own module loader, from the scene's
application document naming it in `controls.sets`, as it would in a browser.
A failure of the window itself — not a problem of the theme — fails the call
with `ERR_UI_CONFORMANCE_WINDOW_FAILED`. What the page, React or a control
writes to the console is logged by the check at debug level, one line at a
time, and never reaches the host's own output.

Stylesheets are parsed with css-tree. A nested rule its block parser misses
(one led by a combinator or an attribute selector) is parsed again on its own,
and is unparseable only if it fails there too.
