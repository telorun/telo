# Changelog

## 0.8.3 - 2026-11-11
### Fixed
* The search engine's template body uses the built-in Telo.Sequence instead of the deprecated Run.Sequence, so using it no longer reports DEPRECATED_KIND.

## 0.8.2 - 2026-11-09
### Fixed
* `requires.telo` now holds the measured floor, raised to the highest floor among the workspace modules this module imports.

## 0.8.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.7.1 - 2026-11-01
### Fixed
* Reformatted the manifest to the canonical layout (short lists and maps in flow style); no change in behaviour.

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.0 - 2026-09-30
### Added
* Web search through the Kagi Search API. modules/kagi implements the web search contract with no controller: it sends the query, the country hint as the region filter, the recency hint as a start date covering the whole window and the configured safe-search flag, returns each result's title, URL, snippet and date, and pages through Kagi's ten pages with a cursor, reading the next page only to decide whether one is issued. A rejected token or address is ERR_SEARCH_ACCESS_DENIED, 429 is ERR_SEARCH_RATE_LIMITED and any other failure ERR_SEARCH_FAILED.
