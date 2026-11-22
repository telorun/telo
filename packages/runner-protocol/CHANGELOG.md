# Changelog

## 0.1.0 - 2026-11-22
### Added
* New package: the runner's client-facing /v1 contract — a normative README, runner-protocol-schema.json holding every request, response, event and error shape, and matching TypeScript types — including the share routes (features.shares, POST/GET /v1/shares, DELETE /v1/shares/{id}), whose name and application are at most 512 characters. The README links the share tunnel's protocol spec. It has no dependencies.
