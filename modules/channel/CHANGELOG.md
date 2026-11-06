# Changelog

## 0.4.0 - 2026-11-06
### Added
* `Channel.ReadUntil.timeout` is a duration (`30s` when omitted): `1m`, `1h30m` and `250ms` are read, an integer is milliseconds, and a malformed literal is refused by `telo check`. A computed value must now be a duration (`!cel "duration('10s')"`), not a string, so a manifest passing a computed string must change. Text with a space before the unit (`5 m`) or around the value is now refused. Requires telo >=0.129.0.

## 0.3.1 - 2026-11-01
### Fixed
* Reformatted the manifest to the canonical layout (short lists and maps in flow style); no change in behaviour.

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.0 - 2026-09-19
### Added
* Channel.SendLine and Channel.ReadUntil report what actually went wrong: writing to a program that has not started is ERR_CHANNEL_NOT_STARTED rather than a closed-channel error, and a second read while one is already waiting is ERR_CHANNEL_CONCURRENT_READ rather than two reads silently interleaving what they consume.
* Channel.Text, Channel.SendLine, Channel.ReadUntil and Channel.End: hold a conversation with a running program over a line-oriented text channel. Read up to a literal marker, answer what it asked, and close its input when the exchange is over. Reads are bounded and report the text that arrived instead of the marker, so a stuck exchange says why rather than hanging. Branching on what came back is the ordinary step grammar.
