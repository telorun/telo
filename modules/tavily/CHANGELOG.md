# Changelog

## 0.2.0 - 2026-09-30
### Added
* Web search through the Tavily Search API. modules/tavily implements the web search contract with no controller: it sends the query with the language's primary subtag, the country as Tavily's country name, the recency hint as time_range and the configured safe-search flag, returns each result's title, URL, content as snippet and publication date, and slices Tavily's single list of at most 20 results with a cursor. A rejected key is ERR_SEARCH_ACCESS_DENIED, 429 is ERR_SEARCH_RATE_LIMITED, 432 and 433 are ERR_SEARCH_QUOTA_EXCEEDED and any other failure ERR_SEARCH_FAILED.
