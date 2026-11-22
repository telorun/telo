# Changelog

## 0.1.0 - 2026-11-22
### Added
* New package: the share tunnel protocol, generation 1 (WebSocket subprotocol telo-share-1) — a normative spec with vectors for every client and relay to replay — and the client engine a shared run uses: one WebSocket to the runner's relay carrying HTTP/2, each visitor request and WebSocket forwarded to the announced local port, reconnecting with the fence epoch, warning once per distinct reason, renewing its credential before expiry through an injected runner credential provider, and ending on a lost share or an unsupported runner.
