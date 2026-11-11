# Changelog

## 0.3.0 - 2026-11-11
### Added
* Imports of workspace modules are relative paths in the source tree; the published form is written at release.

## 0.2.0 - 2026-11-01
### Added
* A blueprint for recurring work: declare a map of jobs, each a cron expression, an optional timezone and the work to run, and get one schedule per job, started together in the order written. Requires telo 0.124.0.
