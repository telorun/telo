# Changelog
## 0.5.1 - 2026-06-05
### Fixed
* `Starlark.Script` is now an Invocable (was incorrectly declared as a Runnable).## 0.5.0 - 2026-06-05
### Added
* The Rust controller now honors cooperative invoke cancellation — it checks the InvokeContext cancellation token before running and refuses with ERR_INVOKE_CANCELLED when the invocation tree was cancelled.## 0.4.1
