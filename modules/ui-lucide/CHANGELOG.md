# Changelog

## 0.2.0 - 2026-10-23
### Added
* An icon used once is declared inline where the entry names it, as icon: { kind: UiLucide.Icon, name: house } — name is the kind's own field, so the object is a declaration — on a runtime from telo 0.121.0.
* New module: UiLucide.Icon is one glyph of the Lucide icon set, named as Lucide names it and provided as its SVG file, for a navigation entry's icon; a name outside the set is refused before the app runs. The glyphs of Lucide 1.8.0 are staged from the lucide-static release with Lucide's ISC notice, and the names and the staged files are one generated list.
