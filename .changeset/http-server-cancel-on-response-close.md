---
"@telorun/http-server": patch
---

Fix spurious request cancellation (HTTP 499) for body-bearing requests whose handler awaits before replying. Per-request cancellation was wired to the request stream's `close` event, which fires as normal cleanup once a request body has been fully received — so any `PUT`/`POST` whose handler did async work (e.g. a DB query) before sending a response was cancelled mid-flight and answered with 499. Cancellation now listens on the response socket, which only closes early on a genuine client disconnect; normal completions and synchronous rejects are unaffected.
