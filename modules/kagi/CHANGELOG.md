# Changelog

## 0.2.0 - 2026-09-30
### Added
* Web search through the Kagi Search API. modules/kagi implements the web search contract with no controller: it sends the query, the country hint as the region filter, the recency hint as a start date covering the whole window and the configured safe-search flag, returns each result's title, URL, snippet and date, and pages through Kagi's ten pages with a cursor, reading the next page only to decide whether one is issued. A rejected token or address is ERR_SEARCH_ACCESS_DENIED, 429 is ERR_SEARCH_RATE_LIMITED and any other failure ERR_SEARCH_FAILED.
