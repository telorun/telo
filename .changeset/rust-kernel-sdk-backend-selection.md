---
"@telorun/kernel": minor
---

Select the Rust SDK's controller backend explicitly when building a `pkg:cargo` controller.

`telorun-sdk` no longer declares a default backend feature. A controller crate carries no `[features]` block, so a backend can only be chosen as a dependency feature from the build that hosts it — `--no-default-features` would apply to the controller crate rather than to the SDK. `NapiControllerLoader` now passes `--features telorun-sdk/napi`, which is what lets the new Rust kernel pass `--features telorun-sdk/native` for the same unchanged crate.
