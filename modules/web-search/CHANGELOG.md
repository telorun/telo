# Changelog

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.0 - 2026-09-30
### Added
* Web search over any engine. modules/web-search is the engine-neutral contract: a search takes a query, an optional count, an opaque cursor and language, country and recency hints, and returns ranked results with title, the URL exactly as the engine reports it, snippet and the reported publication date, plus a cursor present exactly while more results are reachable. Its failure codes (ERR_INVALID_INPUT, ERR_SEARCH_ACCESS_DENIED, ERR_SEARCH_RATE_LIMITED, ERR_SEARCH_QUOTA_EXCEEDED, ERR_SEARCH_FAILED) are a ceiling every engine stays within. Seven exported functions carry what every engine shares: sealing and checking cursors bound to the kind of engine and the search inputs, resolving a hint through an engine's vocabulary table, the start of a recency window, slicing a ranked list with one probe item, and reading a reported date — ISO 8601, a bare date or an HTTP date — into an instant, with an impossible or unreadable date read as none.
