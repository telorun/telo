---
"@telorun/sdk": minor
"@telorun/analyzer": minor
"@telorun/kernel": minor
"@telorun/cli": minor
---

An application can open its own page. The built-in `Telo.OpenUrl` takes an `http` or `https` URL, logs `telo.url.open_requested` with `url.full` on every call and hands the URL to the host, returning `null` at once; no outcome of opening a page is an error. `telo run` at a terminal opens it in the browser (`BROWSER` first, else the system opener, the URL passed as one argument), at most once per address in a session, so a `--watch` reload opens no new tab; `--no-input`, runner sessions and every other host only log it. The terminal opener now reports a failed launch on stderr, for the inspector's `--open` too. A literal URL of another scheme, or one holding a user or password, is refused by `telo check` and a computed one when the call runs, so credentials never reach the log; `telo check` no longer refuses every computed value at a URL slot that forbids a member; the Rust kernel refuses the kind with `ERR_UNSUPPORTED_MANIFEST_FEATURE`. A read of observed state before its resource has started is again reported as `ERR_OBSERVED_STATE_UNAVAILABLE` naming the expression, rather than as a bare missing-key failure. A templated kind's `run:` entry is now started through the kernel's run path, as its `targets:` are, so it may report observed state.
