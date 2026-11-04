---
status: draft
priority: medium
depends-on: []
packages: [modules/ui, modules/ui-react, modules/ui-react-radix, modules/ui-react-conformance, examples/ui-showcase, apps/hub, apps/authoring-agent, docs]
---

# The viewer chooses the look: theme per request, viewer preferences, light and dark

## Problem

A viewer cannot choose how the application looks.

- **The theme is fixed per App.** `UiReact.App.theme` is one reference; only `tokens` can be chosen per request (a list of `{ tokens, when }`). The showcase offers four looks by mounting the same pages four times (`/`, `/radix`, `/brand`, `/sidebar`) and linking between mounts, so switching changes every address.
- **A remembered choice is hand-built.** The showcase's brand switch is an `Http.Api` route setting a cookie, a `Telo.Function` parsing the `cookie` header with a regular expression, and the same `when` expression repeated on the token set and on two menu items.
- **Dark follows the operating system only.** The default and Radix themes give dark values under `@media (prefers-color-scheme: dark)`; nothing lets a viewer choose dark on a light system or the reverse, and the shell carries no `color-scheme`.

Home Assistant keeps a theme and a light/dark mode per user, chosen from the profile page, with nothing for the dashboard author to write.

## Solution

**Viewer preferences — vocabulary in `ui`, storage in the renderer.** `ui` declares the `Ui.Preferences` shape — a map of named choices, each `{ label, choices: [{ value, label }], default }`, `value` matching `^[a-z][a-z0-9-]*$`, `label` a `Text` — and a `preference` node, `{ type: preference, name, label? }`, drawn through the `Select` control. `UiReact.App` takes `preferences` of that shape and implements the storage:

- **Setting.** `POST <mount>/_telo/ui/preferences` with a JSON body `{ name, value }`. It is refused unless `Content-Type` is `application/json` and the request is same-origin — `Sec-Fetch-Site: same-origin`, or, where that header is absent, an `Origin` equal to the request's own; a request carrying neither is refused. An unknown name or value is a 400 problem.
- **Storing.** One cookie per preference, `telo-pref-<mount>-<name>` where `<mount>` is the first eight hex digits of the SHA-256 of the mount path, so two Apps on one host — nested mounts included — never read each other's; `Path` the mount path, `SameSite=Lax`, `HttpOnly`, `Secure` on HTTPS, one year. Only the server reads it.
- **Reading.** Every per-request expression reads `request.preferences.<name>`, always present (the stored value, else `default`; a stored value no longer among the choices reads as the default, silently, since the viewer chose something the application no longer offers). The member is typed by the projection of the App's `preferences` map (`x-telo-schema-projection`), each an enum of its values, so `request.preferences.loook` is `CEL_UNKNOWN_FIELD` and comparing to an undeclared value is a type error. The application document carries the current values (`preferences: { <name>: <value> }`), which is what a `preference` node shows.
- **Changing.** Choosing in a `preference` node posts once, then re-reads the application and page documents; when the new application document lists different stylesheets or control sets than the one drawn, the page reloads instead.

**The theme per request.** `UiReact.App.theme` takes either one reference, as now, or a list of `{ theme, when? }`, the first entry whose `when` holds applying; the last entry has no `when`. Every listed theme's stylesheets, control sets and browser entries are built at start, as one theme's are today, so a choice costs no build per request.

**Light and dark, chosen.** `UiReact.App.colorScheme` is `{ default: system | light | dark, choosable }`. With `choosable: true` the App has the built-in preference `colorScheme` (`system`, `light`, `dark`, with keyed labels), read as `request.preferences.colorScheme` and drawn by a `preference` node; a declared preference may not take that name. The shell is served with `color-scheme` on its root element set from the effective choice (`light dark` for `system`), so the first paint, before any script, is in the chosen scheme. Shell variants are one per served language and scheme choice, built on first request and kept — a set bounded by the declaration.

**Themes express both schemes through `light-dark()`.** `UiReact.Theme` gains an optional `schemes` (`[light]`, `[dark]` or `[light, dark]`). The default theme, the Radix theme and the showcase brand theme declare theirs and give every colour token, every shadow token's colour component (`0 1px 2px 0 light-dark(…, …)`) and every value of the derived layer (`--ui-react-derived-*`, mixed per scheme) through `light-dark()`, dropping their `prefers-color-scheme` blocks; the root's `color-scheme` then selects one, the system's or the viewer's. `CheckTheme` holds a theme declaring both schemes to that (new problem `scheme-media-query` for a colour under a scheme media query). A theme declaring no `schemes` keeps working as today and cannot be chosen between schemes. A `Ui.DesignTokens` colour or shadow may be written `{ light, dark }`, which the renderer emits as `light-dark()`, so an application's brand gives both schemes in one typed token. The renderer's browser floor — the releases supporting `light-dark()`, Baseline since May 2024 — is stated in `styling.md`.

**Caching.** A document or shell whose expressions read `request.preferences` (the shell does whenever `colorScheme` is choosable) adds `Cookie` to `Vary`, is `Cache-Control: private, no-cache`, and carries an ETag per variant; the files under `_telo/ui/assets/<digest>/` stay immutable.

**Rules**, each pinned both ways in its module's tests and twinned at start: `UI_THEME_CHOICE_UNCONDITIONED_LAST` (a theme list ending in a conditioned entry); `UI_THEME_SCHEME_UNSUPPORTED` (`choosable: true`, or a fixed `default` scheme, over a listed theme whose `schemes` lack it or are absent); `UI_PREFERENCE_DEFAULT_UNKNOWN` (a `default` outside the choices); `UI_PREFERENCE_CHOICE_DUPLICATE`; `UI_PREFERENCE_NAME_RESERVED` (`colorScheme`); `UI_PREFERENCE_UNDECLARED` (a `preference` node naming no preference).

**Before / after.** Before, offering a Radix look and a dark mode is four mounts, a cookie route, a cookie parser and repeated conditions. After, one App lists two themes chosen by `request.preferences.look`, sets `colorScheme: { choosable: true }`, and places two `preference` nodes in its header.

## Decisions

- **Preferences are a general key, not a theme switch.** A look, a scheme, a density, a default page size are all "a choice the viewer makes once and the server reads per request"; one typed mechanism serves them. Rejected: a dedicated theme-picker kind.
- **The shape and node in `ui`, the cookie in `UiReact.App`.** What a preference is and how one is chosen is renderer-neutral; how it is stored is the serving renderer's, as its other routes are.
- **Cookies, read on the server.** The server chooses the documents and stylesheets, so the choice must reach it with the first request; browser storage would paint the wrong theme first.
- **The language is not a preference.** `Http.Server.preferredLanguages` already chooses it before the request reaches the App, and it decides more than the screens.
- **`light-dark()` instead of a scheme attribute.** One declaration per token holds both values and follows `color-scheme` wherever it is set, so the viewer's choice and the system's are one mechanism. Shadows carry it in their colour position, where it is valid.
- **A theme states its schemes**, and a theme stating none is never forced: dark browser widgets beside light content is refused before the app runs.
- **The last theme entry is unconditioned.** Unlike tokens, which fall back to the theme's own, there is no theme beneath a theme.

Bookkeeping: docs (`ui-react` `app.md` § Look, new `preferences.md`, `theme.md`, `styling.md` with the browser floor, `urls.md` with the preferences route; `ui` `nodes.md` with the `preference` node, new `preferences.md`, `design-tokens.md` with `{ light, dark }`; `ui-react-conformance` `checks.md`); the showcase rebuilt on one mount with a look preference over its three themes, a `colorScheme` choice and its brand as a preference, its cookie route and cookie function removed, with tests under its `tests/`; keyed texts for the scheme choices in all fourteen catalogs; the hub `build-ui` guide's themes section (within its 32768-byte bound), the primer, `modules/CLAUDE.md`; the ledger's "Swappable themes" entry extended with viewer choice and dark mode; `Added` fragments for `ui`, `ui-react` (describing the `light-dark()` change for theme authors), `ui-react-radix`, `ui-react-conformance`; changesets for `@telorun/ui-react-contract` and `@telorun/ui-react` where their published code moves. `requires:` floors where the previous published CLI, run against a module's own file with the block stripped, rejects it — the showcase and the themes declaring `schemes`.

## Verify

- An App with `preferences: { look: … }` and a two-theme list: choosing Radix in the `preference` node posts once, reloads, and every later page is drawn by Radix's controls; a new visit keeps it.
- With `colorScheme: { choosable: true }`, choosing dark on a light system serves the shell with `color-scheme: dark`, and the first paint with scripts disabled is dark; `system` follows the operating system again.
- A cross-origin `POST`, one with neither `Sec-Fetch-Site` nor `Origin`, and one with a form content type are each refused and set no cookie; an unknown name or value is a 400 problem.
- Two Apps at `/` and `/admin` on one host, both declaring `look`, keep separate choices.
- A shell read with a preference cookie carries `Vary: Cookie` and a different ETag per scheme.
- Each rule above is refused at the declaring library and fails a consumer's run with its twin; `CheckTheme` passes for both built-in themes and the showcase theme, and reports `scheme-media-query` for a theme declaring both schemes with a `prefers-color-scheme` block.

## Example after the change

```yaml
kind: UiReact.App
metadata: { name: app }
title: Tasks
preferences:
  look:
    label: Look
    default: standard
    choices: [{ value: standard, label: Standard }, { value: radix, label: Radix }]
colorScheme: { default: system, choosable: true }
theme:
  - { theme: !ref Radix.theme, when: !cel "request.preferences.look == 'radix'" }
  - { theme: !ref UiReact.defaultTheme }
header:
  end:
    - { type: preference, name: look }
    - { type: preference, name: colorScheme }
pages: [!ref home]
```
