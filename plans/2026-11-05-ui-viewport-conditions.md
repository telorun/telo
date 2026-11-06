---
status: draft
priority: low
depends-on: []
packages: [modules/ui, modules/ui-react, examples/ui-showcase, apps/hub, apps/authoring-agent, docs]
---

# Conditions on the viewer's screen

## Problem

A screen cannot change what it draws by the device it is on. `compactBelow` switches the renderer's own pieces — surfaces become drawers, the navigation a menu or tab bar, a listing its `compact` layout — but an author's own nodes have no such switch: a page cannot show a short summary on a phone and a full table on a desk, a dark-scheme logo in dark mode, or larger targets for touch. The server cannot decide it either: a node's `when` runs per request, where the viewport is unknown.

Home Assistant's `screen` condition takes a media query string per card. A string media query is opaque to static analysis; a fixed set of typed facts is not.

## Solution

**A `viewport` root, bound once.** `viewport` is declared a single time, as an accessor-only binding in a region on the `Ui.Condition` shape itself — the shape every `shown`, and `Ui.Enablement` (`enabled` on an action or row action), reaches by `$ref`. Regions inside named shapes are reached by the one walk that collects every region, so `viewport` is in scope wherever a condition is written: on a page's own children, inside a `Ui.Data` content, on a field, inside a composite declared as its own resource, on an `enabled`. It is the one root bound by the condition rather than by the resource holding it — a deliberate widening of "a root is in scope only where the resource binds it", recorded in `conditions.md` and `modules/CLAUDE.md`, because the viewport belongs to no resource.

Its members, typed by a closed `Ui.Viewport` shape and each defined as a fact a renderer of any kind maps to its platform's own:

| Member | Type | Is |
| --- | --- | --- |
| `compact` | boolean | the viewport is narrower than `compactBelow`, the same test every compact slot uses |
| `width` | number | the viewport's width in CSS pixels (device-independent pixels) |
| `scheme` | `light` \| `dark` | the colour scheme the page is drawn in |
| `pointer` | `fine` \| `coarse` | the primary pointer: precise (a mouse) or not (a finger) |
| `reducedMotion` | boolean | the viewer asked for reduced motion |

`viewport.widht` is `CEL_UNKNOWN_FIELD` and `{ at: viewport.scheme, matches: { const: dim } }` is `MATCH_UNSATISFIABLE`, both before the app runs, through the checks every condition already gets. Being accessor-only (`x-telo-context-eval: accessor`), evaluated CEL — `when`, text — never names it (`CEL_UNKNOWN_IDENTIFIER`), and neither do `value` / `list` nodes or address parameters, which bind their own roots.

**Behaviour.** The renderer measures every member synchronously before the first render, so the first paint already shows the right branch. Each change — a resize, crossing `compactBelow`, a scheme or pointer change — re-evaluates only the conditions reading the changed member, at most once per animation frame for `width`, and re-renders a subtree only when its condition's verdict flips. Content a condition hides leaves the accessibility tree while staying mounted, keeps its state and starts no request, as every `shown` does; two alternatives both stay mounted, at the cost of their memory.

`scheme` is the scheme actually drawn: the system's today, and the viewer's choice where the theme-choice plan provides one, so a condition and the theme's colours never disagree. `pointer` describes the primary pointer only; a device may have both, so a condition on it adjusts presentation and never gates the only way to reach content or an action, which the docs say. `reducedMotion` is for conditions; the renderer's own animations follow the platform setting directly.

On the wire a condition reading `viewport` is a binding of root `viewport`, so the spec needs no new shape. Conformance vectors in `modules/ui/conformance/` pin each member's meaning over a fixed viewport fixture, which a renderer's tests supply.

**Before / after.** Before, a page shows its table on a phone or not at all. After, `shown: { at: !cel "viewport.compact", matches: { const: true } }` on a summary list and the opposite on the table draw one or the other.

## Decisions

- **Typed members, not a media query string.** A media query cannot be type-checked or matched against `Ui.Match`; five named facts cover what screen conditions are used for — size, scheme, input method, motion — and each is checked like any other value. Rejected: `screen: "(min-width: 768px)"`, and a `hover` member, which follows from `pointer` on every device class it would distinguish.
- **`width` stays beside `compact`**: `compactBelow` is the one breakpoint the renderer has, and `width` is the only way an author draws at another.
- **Bound on the condition, not per region.** Binding `viewport` in each region that offers conditions would touch dozens of regions and miss the next one added.
- **Browser-side only.** A per-request `when` cannot know the viewport, and guessing it from the user agent is wrong for every resized window. A node shown by viewport is still delivered, so this is never a way to keep content from a viewer.

Bookkeeping: docs (`conditions.md` with the root and the widened scope rule, `nodes.md`); the `viewport` row in every doc's browser-roots table; the conformance vectors; a showcase conditions-page section with a page-document test; the hub `build-ui` guide's condition paragraph (within its 32768-byte bound), the primer, `modules/CLAUDE.md`'s browser-roots list; the ledger's "Screens that follow their data" entry extended with the viewer's screen; `Added` fragments for `ui` and `ui-react`. `requires:` floors where the previous published CLI, run against a module's own file with the block stripped, rejects it.

## Verify

- `viewport.compact` read by a condition on a page's own child, inside a `Ui.Data` content, inside a composite declared as its own resource, and in an action's `enabled` type-checks in all four.
- Two nodes conditioned on `viewport.compact` swap when the window crosses `compactBelow`, without a request and without unmounting either; a cold load at phone width paints the phone branch first.
- An `image` shown under `viewport.scheme` `dark` appears when the system scheme turns dark.
- `viewport.widht` is `CEL_UNKNOWN_FIELD`; a `const: dim` match on `scheme` is `MATCH_UNSATISFIABLE`; `viewport` in a `when` is `CEL_UNKNOWN_IDENTIFIER` — each refused before the app runs.
- A condition on `viewport.width` with `minimum: 1200` re-renders its subtree once when crossing 1200 during a continuous resize, not per frame.

## Example after the change

```yaml
children:
  - type: composite
    ref: !ref taskTable
    shown: { at: !cel "viewport.compact", matches: { const: false } }
  - type: composite
    ref: !ref taskSummary
    shown: { at: !cel "viewport.compact", matches: { const: true } }
  - type: image
    src: /brand/logo-dark.svg
    alt: Acme
    shown: { at: !cel "viewport.scheme", matches: { const: dark } }
```
