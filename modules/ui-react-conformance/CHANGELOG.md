# Changelog

## 0.5.1 - 2026-11-01
### Fixed
* Reformatted the manifest to the canonical layout (short lists and maps in flow style); no change in behaviour.

## 0.3.0 - 2026-10-23
### Added
* `CheckTheme` counts a token the renderer itself reads (the contract's `rendererTokens`) as read, still asking the theme for its default, and treats `padding`, `padding-left`, `padding-right`, `padding-inline-start` / `-end` as setting a reserved `padding-inline`, `margin`, `margin-left`, `margin-right`, `margin-inline-start` / `-end` as setting a reserved `margin-inline`, `grid-area` and `grid-column-start` / `-end` as setting a reserved `grid-column`, and `max-inline-size` as setting a reserved `max-width`.

## 0.2.0 - 2026-10-23
### Added
* A rule setting background, mask, -webkit-mask or -webkit-mask-image on a part is held to that part's reserved background-color or mask-image, and the vector host turns an element spec at any depth of a prop into an element, so a Navigation vector hands an entry its icon.
* Checks against ui_react_controls-2: a set's nine layer controls, the Navigation and Tabs vectors, and a tooltip opened over a menu node's navigation panel that Escape closes alone.
* New module: UiReactConformance.CheckTheme and UiReactConformance.CheckControls hold a ui-react theme or control set to the renderer's contract from the publishing module's own tests, answering { problems: [{ check, subject, message }] } — unstyled parts, stale unstyled entries, reserved layout properties, design tokens the theme gives no default or never reads, unparseable stylesheets, scenes that break under the theme's controls, failed behaviour vectors (each layer drawn in a root marked data-telo-layer) and sets that do not load — in a happy-dom window, one worker per check. The token names come from ui's @telorun/ui entry and their CSS spelling from ui-react's @telorun/ui-react-contract.
