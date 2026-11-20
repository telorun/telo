# Bill-of-materials conformance vectors

The canonical bytes of the CycloneDX documents Telo writes — a module artifact's stored record (`sbom.cdx.json`, `kernel/specs/module-artifact.md` §7) and every document composed from records — frozen as data. Every writer reads `vectors.json` and produces each row's `expected` text exactly, byte for byte. Editing one expected text breaks every runner until each implementation writes it.

## Format

`vectors.json` is one object with two lists:

- `canonical` — rows `{ id, document, expected }`: `document` is any JSON document and `expected` its canonical text. Every array is ordered (`components` by `bom-ref`, `properties` by `name` then `value`, `dependencies` by `ref`, `dependsOn` and `assemblies` by value, any other array by each element's canonical serialization, every comparison in UTF-16 code-unit order), every member holding an empty array is omitted, and the result is written as RFC 8785 (JCS) followed by one line feed.
- `records` — rows `{ id, input, expected }`: `input` is what the producers of one payload reported — `subject` (`type`, `name`, optional `version` and `license`), `components` (one report per component and layer: versionless `purl`, `version`, `occurrence` — the `telo:layer` value — and optional `license`, `cpe` and `vcs` `{ url, revision }`), `contains` (edges `{ from, to }` between component references, a reference being the purl with `@` and the percent-encoded version inserted before any qualifiers, the `vcs_url` qualifier valued `<url>@<revision>` added for a report with `vcs`, and the qualifiers in canonical form: keys lower-case and sorted, every value octet outside `A–Z a–z 0–9 - . _ ~` percent-encoded), and `incomplete` (the `telo:incomplete` values) — and `expected` the stored record's canonical text. Reports of one reference merge into one component carrying every occurrence and the first license and CPE given, so two revisions of one version are two components.

## Runners

- `analyzer/nodejs/tests/bill-of-materials-conformance.test.ts` — the Node writer.

A Rust publisher owes a runner of both lists. The vectors are not built-in vocabulary: nothing under `sdk/builtins/` reads them, and no runtime ships them.
