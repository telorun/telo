# Plan — `modules/pdfmake`: authoring PDF documents

## Problem

Telo cannot create a PDF. `modules/pdf` reads and annotates: `Pdf.Rasterizer` renders a page to an image, `Pdf.FormFields` adds AcroForm boxes to a document that already exists. There is no way to make a page, draw text, lay out a table, or place artwork — so a branded report (background graphic, header cards, a styled table with a totals row, a donut chart, a logo) has no route at all. `pdf-lib` is already a dependency but no kind exposes its authoring surface, and it has no layout engine regardless.

## Solution

A new `modules/pdfmake` (`metadata.name: PdfMake`), a **typed binding to pdfmake**, delivered bundled as `pkg:telo`.

- **`PdfMake.Nodes`** — a `Telo.Type` schema-only carrier, one `$def` per pdfmake node type (text, table, columns, stack, image, svg, canvas, ordered and unordered lists, page break), recursive through `$ref` for the container nodes. Field names mirror pdfmake's document definition verbatim, so an example from pdfmake's documentation or playground pastes in and works.
- **`PdfMake.Document`** — `Telo.Invocable`, PDF bytes out. Owns page size and orientation and margins, `defaultStyle`, the named `styles` map, `background`, `header` and `footer`, the `fonts` map, and `content` — whose schema is anchored to the carrier through `x-telo-schema-from`, the same mechanism `Http.Api` uses to anchor its route matcher to `HttpDispatch.Request`.

`content` is annotated `x-telo-eval: runtime`, so CEL reaches every leaf and one document resource is one report *template*, invoked once per customer with that customer's rows.

**Where pdfmake takes a function, we cannot mirror it.** Table `layout`, `background`, `header`, `footer` and `pageBreakBefore` are callbacks, manifests hold no functions, and pdfmake invokes them synchronously during layout so CEL cannot fill them either. These become declarative instead: a `layout` object (line widths and colours, cell padding, header fill, alternating row bands) plus an optional per-row `style` key carried in the data. The totals row in a report is then simply a row tagged with a different style — data-driven, statically typed, no callbacks. This divergence is documented as the one place the binding is not a mirror.

**Assets** come from the `!include-*` tags: brand fonts as `!include-bytes` into the `fonts` map, background artwork as `!include-text` into an SVG node. Roboto ships as the default font so a document renders with no font configuration at all.

**Charts compose by value.** The application invokes a `Chart.SvgWriter` in a step and passes the resulting markup into an SVG node; `modules/pdfmake` never learns that `modules/chart` exists.

**Delivery is bundled, and this was verified rather than assumed.** pdfkit's Node entry reads the standard-font AFM metrics from a sibling `js/data/` directory and declares a `brfs` browserify transform, which esbuild does not run — precisely the "resolves a file beside itself" trap that pins `pdf` and `image` to `pkg:npm`. pdfmake's self-contained `build/pdfmake.js` has that data and the linebreak trie already inlined and resolves nothing beside itself, so it bundles. If it proves unusable under Node, the fallback is `pkg:npm` alongside its siblings, at no cost to the rest of the design.

Ships with `modules/pdfmake/docs/` per kind (mandatory), a test suite rendering fixtures and asserting structure by re-reading the output through `Pdf.Rasterizer`, a changie fragment, a `scripts/gen-changie-config.mjs` re-run, and the authoring-agent system prompt update CLAUDE.md requires.

**Depends on** the `!include-text` / `!include-bytes` tags plan (fonts and artwork) and the schema-error-diagnostics plan (union messages); composes with the charts plan but does not depend on it.

## Decisions

- **Its own module named after the library, not new kinds in `modules/pdf`.** `Pdf.Text` and `Pdf.Table` would advertise themselves as generic PDF concepts while actually being one library's shape — a mislabel in the registry and in hub search. `modules/starlark` is the standing precedent for a module named after what it binds. It also keeps a ~2.5 MB bundled controller out of the module people import to rasterize a page, and leaves npm-delivered `modules/pdf` untouched.
- **Surface pdfmake's vocabulary rather than invent one.** Copy-paste from pdfmake's documentation, playground and the years of answers written about it is the practical value here, and an invented vocabulary would be an abstraction over a set of one implementation. A generic document abstract can be introduced later if a second engine ever appears — with a real second case to design against.
- **Node types as `$defs` in a `Telo.Type` carrier — not inline resource kinds, not an anonymous schema.** This is the established `http-dispatch` / `mcp-server` pattern: a document node has no lifecycle and no runtime instance, `Telo.Type` is the sanctioned kind-without-an-instance, and `x-telo-schema-from` already anchors a consumer's field to another kind's `$defs`, so no new annotation is needed. Rejected: inline `{ kind: … }` nodes, which give every leaf a fake identity and stop `x-telo-eval` coverage at each nested kind boundary. Rejected: anonymous `$defs` inside `PdfMake.Document`, which would leave the vocabulary undiscoverable and undocumented.
- **Few carriers with many `$defs`, not a kind per node type** — the convention the two existing schema-only modules already follow.
- **Discrimination by which key is present, mirroring pdfmake, with no added `type:` field.** This is what keeps copy-paste literal. Its cost is that a malformed node fails a keyless union, which is why this plan depends on the union reduction in the schema-error-diagnostics plan rather than paying for message quality with a discriminator property.
- **No raw document-definition escape hatch.** Passing an unchecked object through would void static validation and visual editing for the whole document — the two properties the typed carrier exists to provide. Coverage gaps get closed in the carrier schema instead.
- **Implementation risk, named up front:** anchoring a `$defs` subtree across kinds must rebase its internal `#/$defs/…` pointers onto the carrier, or the recursion that containers depend on silently resolves against the wrong document.

## Example after the change

```yaml
kind: PdfMake.Document
metadata: { name: CustomerReport }
pageSize: A4
pageOrientation: landscape
fonts:
  Brand:
    normal: !include-bytes assets/Brand-Regular.ttf
    bold: !include-bytes assets/Brand-Bold.ttf
defaultStyle: { font: Brand, fontSize: 10 }
styles:
  cardTitle: { fontSize: 18, bold: true, color: "#1B36C4" }
  tableHeader: { bold: true, color: "#FFFFFF", fillColor: "#1B36C4" }
  totalsRow: { bold: true, color: "#FFFFFF", fillColor: "#1B36C4" }
background:
  svg: !include-text assets/page-background.svg
content:
  - columns:
      - { text: !cel "'Customer: ' + inputs.customer", style: cardTitle }
      - { text: !cel "inputs.from + '  —  ' + inputs.to", style: cardTitle }
  - columns:
      - table:
          headerRows: 1
          widths: [ auto, auto, "*", auto ]
          body: !cel "inputs.rows"
        layout:
          hLineWidth: 0.5
          hLineColor: "#1B36C4"
          paddingTop: 4
          paddingBottom: 4
      - svg: !cel "inputs.chartSvg"
```

`inputs.rows` carries a `style` key per row, so the totals row renders as `totalsRow`; `inputs.chartSvg` is the markup an earlier step got from a `Chart.SvgWriter`.
