# Plan — `modules/pdfmake`: authoring PDF documents

## Problem

Telo cannot create a PDF. `modules/pdf` reads and annotates: `Pdf.Rasterizer` renders a page to an image, `Pdf.FormFields` adds AcroForm boxes to a document that already exists. There is no way to make a page, draw text, lay out a table, or place artwork — so a branded report (background graphic, header cards, a styled table with a totals row, a donut chart, a logo) has no route at all. `pdf-lib` is already a dependency but no kind exposes its authoring surface, and it has no layout engine regardless.

## Solution

A new `modules/pdfmake` (`metadata.name: PdfMake`), a **typed binding to pdfmake**, delivered bundled as `pkg:telo`.

- **`Node`** — a **named shape** (a `Telo.JsonSchema` the library exports) whose **root is the node union**, with one `$def` per pdfmake node type (text, table, columns, stack, image, svg, canvas, ordered and unordered lists, page break); container nodes recurse by referencing the shape's root. Field names mirror pdfmake's document definition verbatim, so an example from pdfmake's documentation or playground pastes in and works.
- **`PdfMake.Document`** — `Telo.Invocable`, PDF bytes out. Owns page size and orientation and margins, `defaultStyle`, the named `styles` map, `background`, `header` and `footer`, the `fonts` map, and `content` — an array whose items are that shape.

`content` is annotated `x-telo-eval: runtime`, so CEL reaches every leaf and one document resource is one report *template*, invoked once per customer with that customer's rows. `background`, `header` and `footer` are the same.

**Where pdfmake takes a function, we cannot mirror it.** Table `layout`, `background`, `header`, `footer` and `pageBreakBefore` are callbacks, manifests hold no functions, and pdfmake invokes them synchronously during layout so CEL cannot fill them either. These become declarative instead: a `layout` object (line widths and colours, cell padding, header fill, alternating row bands) plus an optional per-row `style` key carried in the data. The totals row in a report is then simply a row tagged with a different style — data-driven, statically typed, no callbacks. This divergence is documented as the one place the binding is not a mirror.

**Composite documents compose by VALUE, and this module grows no extension hole.** An invoice, a statement or a `Crud.Report` is a kind that returns node data: a step invokes it with that call's arguments and the result lands in `content` through CEL, exactly as a chart's SVG does. Nothing new is needed — the composite declares the shape as its `outputType`, so its result is type-checked against the same grammar the document validates against, and `content` stays one recursive shape of plain data with no reference variant in it.

A reference-typed variant inside the shape was considered and rejected. As a `Telo.Provider` it cannot carry data at all — `provide()` is parameterless, so a composite reached that way could never see the rows the document was invoked with, which is the entire reason such a hole would exist. As a call slot it would put a control-transferring reference at arbitrary depth inside a `x-telo-eval: runtime` data tree, giving the recursive grammar two readings (data, and a dispatch site) for the sake of a composition that already works one step earlier.

**Assets** come from the `!include-*` tags: brand fonts as `!include-bytes` into the `fonts` map, background artwork as `!include-text` into an SVG node. Roboto ships as the default font so a document renders with no font configuration at all.

**Charts compose by value.** A chart kind is one invocable that returns `result.svg` — `plans/svg-charts.md` deliberately rejected a chart/writer split, so there is no separate writer to invoke. A step invokes the chart and passes its markup into an SVG node; `modules/pdfmake` never learns that `modules/chart` exists.

**Delivery is bundled, and this was verified rather than assumed.** pdfkit's Node entry reads the standard-font AFM metrics from a sibling `js/data/` directory and declares a `brfs` browserify transform, which esbuild does not run — precisely the "resolves a file beside itself" trap that pins `pdf` and `image` to `pkg:npm`. pdfmake's self-contained `build/pdfmake.js` has that data and the linebreak trie already inlined and resolves nothing beside itself, so it bundles. If it proves unusable under Node, the fallback is `pkg:npm` alongside its siblings, at no cost to the rest of the design.

**Verification needs a reader, so `modules/pdf` gains one.** A rasterizer produces a page image, whose bytes move with the platform's font rasterization — it can say a document rendered, never that the table has a totals row. So a text-extraction kind lands in `modules/pdf` first (extracted text plus page count, per page), and this module's tests assert on that: the declarative table `layout`, the per-row `style` divergence and the CEL-expanded content are exactly what has no other regression protection. A smoke assertion that the output parses as a PDF covers the rest.

Ships with `modules/pdfmake/docs/` per kind (mandatory), that test suite, and a release fragment for each of the two modules it touches.

**Depends on** the schema-error-diagnostics plan (union messages), which has **landed** — a node matching no branch names the alternatives by the key each requires, instead of concatenating ten branches' complaints. The `!include-text` / `!include-bytes` tags it uses for fonts and artwork have **landed** (`templating/nodejs/src/engines/include.ts`), so that dependency is discharged. Composes with the charts plan but does not depend on it.

## Decisions

- **Its own module named after the library, not new kinds in `modules/pdf`.** `Pdf.Text` and `Pdf.Table` would advertise themselves as generic PDF concepts while actually being one library's shape — a mislabel in the registry and in hub search. `modules/starlark` is the standing precedent for a module named after what it binds. It also keeps a ~2.5 MB bundled controller out of the module people import to rasterize a page, and leaves npm-delivered `modules/pdf` untouched.
- **Surface pdfmake's vocabulary rather than invent one.** Copy-paste from pdfmake's documentation, playground and the years of answers written about it is the practical value here, and an invented vocabulary would be an abstraction over a set of one implementation. A generic document abstract can be introduced later if a second engine ever appears — with a real second case to design against.
- **Node types as `$defs` under one exported shape — not inline resource kinds, not an anonymous schema.** A document node has no lifecycle and no runtime instance. Rejected: inline `{ kind: … }` nodes, which give every leaf a fake identity and stop `x-telo-eval` coverage at each nested kind boundary. Rejected: `$defs` private to `PdfMake.Document`, which would leave the vocabulary undiscoverable, undocumented, and unusable as the `outputType` a composite section declares.
- **The vocabulary is a NAMED SHAPE, not a schema-only kind reached by `x-telo-schema-from`.** A named shape is registered under a module-scoped id, so a reference to it carries its own resolution base and the self-recursion the container nodes depend on resolves by construction. `x-telo-schema-from` instead extracts a subtree and validates against it standalone, where every internal pointer resolves against a root that has no `$defs` — unsuitable for a recursive grammar, which is why `Http.Api`'s shallow, non-recursive anchors never hit it. This is also what makes the shape's ROOT the node union: a named shape is addressed whole, never as a fragment.
- **A shape referenced from a kind's `schema:` had to be made to work first.** Both halves went blind at such a reference, in opposite ways that hid each other: the analyzer validated resource config on an instance where named shapes were never registered, so the schema failed to compile and the failure was swallowed — `telo check` reported nothing about a resource the kernel then rejected at boot; and every walk that places a CEL stand-in stopped at the reference, so a described value read as undescribed and its expressions were reported as violations of a value nobody wrote. Both are fixed, and a reference now carries its own base so the shape's own `$defs` resolve at the shape rather than at the referrer.
- **One shape with many `$defs`, not a kind per node type** — a node is data, and a kind per node type would give each leaf an identity nothing dispatches on.
- **Discrimination by which key is present, mirroring pdfmake, with no added `type:` field.** This is what keeps copy-paste literal. Its cost is that a malformed node fails a keyless union, which is why this plan depends on the union reduction in the schema-error-diagnostics plan rather than paying for message quality with a discriminator property. Each node `$def` declares its naming key as `required` — that is what branch selection keys on, and a branch written as properties alone is indistinguishable from every other, so the whole vocabulary would fall through to the alternatives listing.
- **No raw document-definition escape hatch.** Passing an unchecked object through would void static validation and visual editing for the whole document — the two properties the typed vocabulary exists to provide. Coverage gaps get closed in the shape instead.
- **The shape is closed; extension happens one step out.** A module that owns data contributes a document by returning node data from an invocable, not by placing a reference inside the grammar. What the shape holds stays plain data at every depth.
- **Theme tokens stay per-medium.** This module keeps `styles` / `defaultStyle`; `modules/ui` keeps `Ui.Theme` and `modules/chart` keeps `palette`. A neutral token module shared across all three was considered and rejected — it couples three modules' release cadence to one vocabulary before any has shipped, and the duplication is a handful of literals.
- **Text extraction lands in `modules/pdf` first**, as its own kind: it is a generic PDF read capability that belongs beside `Rasterizer`, not a test helper, and this plan cannot be verified without it.

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

`inputs.rows` carries a `style` key per row, so the totals row renders as `totalsRow`; `inputs.chartSvg` is the `result.svg` an earlier step got from a chart invocable.
