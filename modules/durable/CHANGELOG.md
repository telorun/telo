# Changelog

## 0.4.3 - 2026-11-09
### Fixed
* The restriction's lower bound named telo 0.130.0, which was never published; it now names 0.131.0, the first published release at or above it.

## 0.4.2 - 2026-11-09
### Fixed
* The telo requirement that static checking cannot see is now a `restrictions:` entry carrying its reason, and `requires.telo` holds the measured floor.

## 0.4.1 - 2026-11-08
### Fixed
* Documentation links now point at telo.run pages and hub module pages instead of the repository tree.

## 0.4.0 - 2026-11-06
### Added
* `Durable.Sleep.for` and `Durable.Await.timeout`, and the `timeout` an await call takes as an input, are durations: `30d`, `1w`, `1h30m` and `250ms` are read, an integer is milliseconds, and a malformed literal is refused by `telo check`. A computed value must now be a duration (`!cel "duration(inputs.delay)"`), not a string, and a negative one is refused when the sleep or await runs, so a manifest passing a computed string must change. Text with a space before the unit (`5 m`) or around the value is now refused. Requires telo >=0.130.0.

## 0.3.1 - 2026-11-01
### Fixed
* Reformatted the manifest to the canonical layout (short lists and maps in flow style); no change in behaviour.

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.1 - 2026-09-07
### Fixed
* Starting a run now declares what it answers with. `Durable.Run` states the floor every engine keeps — the run's id and where it stood — and `DurableLocal.Workflow` narrows it to `{ runId, status }` plus `started` / `attached` / `result`. Undeclared, that contract typed as an open object, so a manifest could read a field the start has never returned and hear about it only at runtime; reading one is now a `telo check` error naming the fields there are. A start is an acknowledgement, not an outcome: the body is dispatched detached and answers before its first step has run.

## 0.2.0 - 2026-08-20
### Added
* New: durable execution. A body of steps records what each step returned AND every decision it reached, so a crash and a restart continue where the work stopped rather than repeating every effect or losing them all. Durable.Run is a marker a backend extends; Durable.Idempotent wraps a region the author asserts is safe to re-run so it is recorded as one entry; DurableLocal.Workflow holds the body and drives replay, with DurableLocal.Journal as its storage seam and DurableLocal.Resumer as the recovery path; DurableJournalFile.Journal stores runs as append-only files. Suspension is not in this version — a run that cannot park can still crash and resume.
* Work can now wait — for a duration, until a time, or for a value delivered from outside — and the process is free to exit while it does. Durable.Sleep, Durable.Await and Durable.Value are backend-neutral and name no engine; DurableLocal.Deliver, Status, Result, Cancel, Schedule and Resume address a run from outside. A start no longer blocks: it records the run and returns its id, and Result is how a caller that wants the outcome asks for it, with an optional wait. Waiting inside a region that declares it cannot be held open — a transaction, a lease — is refused at telo check and at runtime, quoting both the region's promise and the wait's reason. A wait inside a concurrent fan-out parks its own branch and lets its siblings finish.
