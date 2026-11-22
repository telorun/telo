# Changelog

## 0.2.0 - 2026-11-22
### Added
* A component may carry vcs: { url, revision }. It is checked when the tool is one OSV matches commits of (OSV_VCS_ECOSYSTEMS, git → GIT) and OSV names the repository in at least one record — one probe per distinct repository, the location normalized as OSV writes it (no trailing / or .git, scheme and host lower-cased) — and its advisories are then OSV's answer to a commit query, each fixed list the fixing commits of that repository; each advisory says what matched it (matchedBy: version or revision). The caller proves the revision is in the repository's history. A failed probe fails the lookup.
* New package @telorun/osv (MIT): the one OSV advisory lookup Telo's tools share — the package types OSV matches by version as data, the batched query with paging, retries with backoff, and each component's checked answer.
