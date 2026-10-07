# Changelog

## 0.3.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.2.0 - 2026-10-03
### Added
* New module. TextDiff.LineDiff is a deterministic CEL function kind that compares two texts line by line and returns the counts of added and removed lines and the changes as hunks, each with its line ranges on both sides and its lines tagged context, added or removed; a final line without a newline is marked noNewline. contextLines (default 3) sets the unchanged lines kept around a change, and a text over maxInputBytes (default 262144) is reported as comparable: false with null counts and hunks instead of being compared. The exported instance lineDiff uses both defaults, called as TextDiff.lineDiff(before, after). Past an internal bound on comparison work the result is still a correct diff but no longer the shortest one.
