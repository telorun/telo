# Changelog

## 0.2.0 - 2026-11-22
### Added
* New module osv with the Osv.Query kind: looks up known vulnerabilities for components given as package URLs and exact versions, returning each component's advisories and whether its package type is matched by version; fails with ADVISORY_LOOKUP_FAILED when the database gives no answer.
* Osv.Query takes an optional vcs: { url, revision } on each component — the git repository and commit embedded code is built from — and echoes it; such a component is checked by its commit when the database records the repository, its advisories name the fixing commits, and every advisory says whether the version or the commit matched it (matchedBy).
