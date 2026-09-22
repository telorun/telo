# Changelog

## 0.2.0 - 2026-09-22
### Added
* WorkflowApp blueprint: one `WorkflowApp.App` declaration serves a list of workflows over HTTP, each at its own endpoint, with a generated OpenAPI document.
### Fixed
* A workflow is checked as the router's own route: its request matcher, `inputs:` and `returns:` entries and their CEL are validated as `Http.Api` validates a route, reported on the workflow's own line. The blueprint's schema declares only what it adds — the titles, a required handler and its reference slot — instead of a looser hand-copied route schema.
