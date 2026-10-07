# Changelog

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.0 - 2026-09-28
### Added
* New module. SecretScan.Detector is a deterministic CEL function kind that scans text with configured rules — a token prefix with a length window, a literal marker, or a Shannon-entropy threshold — and returns one { rule, line, column } per finding, never the matched text. The exported instance credentialFindings detects OpenAI, AWS, GitHub, Google, Slack and Stripe keys, PEM private keys and long high-entropy tokens, and exempts content digests such as sha256- integrity pins. A rule set that can never match — a token rule with no prefixes, a maxLength below its minLength, an entropy threshold above what its charset can carry — is refused by telo check and when the instance is created.
