# Changelog

## 0.5.0 - 2026-11-11
### Added
* Imports of workspace modules are relative paths in the source tree; the published form is written at release.

## 0.4.3 - 2026-11-09
### Fixed
* The telo requirement that static checking cannot see is now a `restrictions:` entry carrying its reason, and `requires.telo` holds the measured floor.

## 0.4.0 - 2026-11-06
### Added
* A workflow's `inputs` declares `default: {}`, so a workflow written without `inputs:` sends `{}` to its handler, and `telo check` refuses one whose handler requires an argument.

## 0.3.4 - 2026-10-18
### Fixed
* The Http.Server the application stands up binds its port under listen:, as http-server 0.38.0 requires; the top-level port: it wrote is refused there.

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.0 - 2026-09-22
### Added
* WorkflowApp blueprint: one `WorkflowApp.App` declaration serves a list of workflows over HTTP, each at its own endpoint, with a generated OpenAPI document.
### Fixed
* A workflow is checked as the router's own route: its request matcher, `inputs:` and `returns:` entries and their CEL are validated as `Http.Api` validates a route, reported on the workflow's own line. The blueprint's schema declares only what it adds — the titles, a required handler and its reference slot — instead of a looser hand-copied route schema.
