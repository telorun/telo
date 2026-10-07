# Changelog

## 0.4.0 - 2026-10-07
### Added
* Released under the MIT License from this version: the manifest declares license MIT, and the published artifact carries the MIT license text in a LICENSE file at the module root. Versions already published keep the license they shipped with.

## 0.3.0 - 2026-08-26
### Added
* Charts as SVG, and a typeface as a resource.

`modules/svg-chart` renders rows to SVG markup — pie, donut, bar, line, area
and scatter, each its own kind over two shared abstracts. Every mapping is an
expression over the row checked against a declared row shape, so a misspelled
column is a startup error rather than an empty chart. Zero rows renders an
empty chart; a null, a non-finite value or a duplicate of a key the chart draws
one mark per is an error naming the row and the accessor.

`modules/font` declares a typeface once — `Font.Family` for its name and face
bytes, `Font.Measure` for how wide a batch of strings renders in it. A family
with no bytes is a valid declaration and measures by estimate, which the result
reports.

BREAKING: `PdfMake.Document`'s `fonts:` map now takes a reference to a
`Font.Family` instead of four inline byte fields, so a document embeds the same
typeface a chart measured against and a page serves. Roboto stays built in and
needs no entry. Embedded fonts also now reach pdfmake as base64 rather than raw
bytes, which is what its virtual filesystem reads — the inline form never
rendered.

## 0.2.0 - 2026-08-23
### Added
* A new module for authoring PDF documents: pages, styled text, tables, columns, stacks, lists, images, SVG artwork and vector canvas, with named styles, page backgrounds, headers and footers, and embedded brand fonts. Field names mirror pdfmake's document definition verbatim, so an example from its documentation pastes in and is checked before anything runs. Content expressions are evaluated per invocation, so one document resource is a report template rendered once per subject. Where pdfmake takes a callback — table layout — the binding declares data instead, and a row that must look different is a row carrying a different style. A document narrows its own parameter list with `inputType:`, which is what makes the template claim checkable — a caller passing the wrong argument name is a `telo check` error rather than an empty field in the rendered PDF. Named styles are closed, so a misspelled style key is reported rather than silently ignored at render.
