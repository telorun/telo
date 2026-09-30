# Changelog

## 0.2.0 - 2026-09-30
### Added
* Web search through the Exa Search API. modules/exa implements the web search contract with no controller: it sends the query with highlights as the only contents, the country hint as userLocation, the recency hint as a start date and the configured moderation flag, returns each result's title, URL, highlights joined as snippet and publication date, and slices Exa's single list of at most 100 results with a cursor. An invalid key or a disabled feature is ERR_SEARCH_ACCESS_DENIED, 402 is ERR_SEARCH_QUOTA_EXCEEDED, 429 is ERR_SEARCH_RATE_LIMITED and any other failure ERR_SEARCH_FAILED.
