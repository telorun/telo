# Changelog

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.0 - 2026-09-30
### Added
* Web search through the Brave Search API. modules/brave implements the web search contract with no controller: it sends the query with Brave's country and search_lang codes where Brave has one, the recency hint as its freshness filter and the configured safe-search level, returns each web result's title, URL, description as snippet and page age as its date, and pages through Brave's ten offsets of 20 with a cursor issued while results remain on the page or Brave reports more. A rejected subscription token is ERR_SEARCH_ACCESS_DENIED, QUOTA_LIMITED is ERR_SEARCH_QUOTA_EXCEEDED, 429 is ERR_SEARCH_RATE_LIMITED and any other failure ERR_SEARCH_FAILED.
