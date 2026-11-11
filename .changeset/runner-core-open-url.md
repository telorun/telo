---
"@telorun/runner-core": minor
---

A session's event stream now carries an `openUrl` event when an app asks for a page to be opened with `Telo.OpenUrl`: `{ app, generation, url, reach, port? }`, derived from the app's `Kernel.OpenUrlRequested` debug frame. Core accepts only an absolute http or https URL without credentials, re-serializes it, and says whether it points at a port the session routes (`port`), a loopback port it does not (`unrouted`) or another address (`external`); each URL is published once per app generation, at most 16 per generation. Clients ignore event types they do not know.
