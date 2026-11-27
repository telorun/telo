# Changelog

## 0.14.0 - 2026-11-27
### Added
* Requires the telo release carrying the widened context reading that ui now uses, since the module imports ui.
* Requires the telo release that checks format: path-template, as the ui module it is built with does: an older telo no longer selects this version.

## 0.12.0 - 2026-11-22
### Added
* Each staged source declares the package its files are a release of (`purl` in `sources:`), the identity a software bill of materials lists.
* Requires the telo release the `ui` module it imports needs.

## 0.11.0 - 2026-11-19
### Added
* Requires the telo release that reads `x-telo-context-withheld` beside `x-telo-context-from-referrer`, since the `ui` module it imports declares its destinations' roots that way.

## 0.10.0 - 2026-11-15
### Fixed
* The README example places its navigation entry in a Ui.Navbar of the application's page layout, as UiReact.App no longer takes a navigation.

## 0.8.0 - 2026-11-09
### Fixed
* `requires.telo` now holds the measured floor, raised to the highest floor among the workspace modules this module imports.

## 0.7.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.5.1 - 2026-11-01
### Fixed
* Reformatted the manifest to the canonical layout (short lists and maps in flow style); no change in behaviour.

## 0.2.0 - 2026-10-23
### Added
* An icon used once is declared inline where the entry names it, as icon: { kind: UiLucide.Icon, name: house } — name is the kind's own field, so the object is a declaration — on a runtime from telo 0.121.0.
* New module: UiLucide.Icon is one glyph of the Lucide icon set, named as Lucide names it and provided as its SVG file, for a navigation entry's icon; a name outside the set is refused before the app runs. The glyphs of Lucide 1.8.0 are staged from the lucide-static release with Lucide's ISC notice, and the names and the staged files are one generated list.
