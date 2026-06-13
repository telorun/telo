# Plan — PDF form agent (pdf + image modules, AI vision tools)

## Problem

We want an AI workflow that receives a flat PDF form (an image-like document with no interactive fields) over HTTP, figures out *where* the form inputs belong by looking at the rendered page, and returns a link to an S3-hosted copy of the PDF with real editable AcroForm fields placed at the discovered coordinates. The convergence mechanism is visual and agent-driven: the model views a rendered page with the current field boxes drawn on, edits the field set through tools (add, move, remove), sees the refreshed preview after every edit, and repeats until every input sits where it belongs — then finalizes. `Ai.Agent` already owns exactly this loop shape. Documents can be large (100+ pages, 1000+ fields), so the model must never carry or re-transmit the whole field set; it speaks only in deltas, and the set itself is server-side state.

The stdlib is missing the primitives and contract pieces this needs: PDF page rasterization, PDF form-field authoring, generic image annotation, images in AI messages **and in tool results** (`std/ai` content is text-only end to end — `content: { type: string }` in messages, and the agent JSON-stringifies every tool result), composite tools (`Ai.Tools` accepts only `telo#Invocable`; `Run.Sequence` is a `Telo.Runnable`), and a way to hand out an S3 object link. Upload is already covered (`Http.Server` `contentTypeParsers` with `stream: true` delivers an `application/pdf` body as `Stream<Uint8Array>`), and so is the field-set store (`Sql.SqliteConnection` supports `:memory:`).

## Solution

**`modules/pdf` (new, `@telorun/pdf`)** — two `Telo.Invocable` kinds, bytes-in/bytes-out per the stdlib binary convention (no paths, no base64):

- **`Pdf.Rasterizer`** — inputs: PDF bytes, page number, render scale; outputs: PNG bytes plus the rendered pixel dimensions and the document page count. Implemented with `pdfjs-dist` rendering onto `@napi-rs/canvas`.
- **`Pdf.FormFields`** — inputs: PDF bytes, a field list (name, field type — text/checkbox, page, x/y/width/height) and the render scale the coordinates were measured at; outputs: new PDF bytes with AcroForm fields added. Implemented with `pdf-lib`. Coordinates are **pixels of the rendered image, top-left origin** — the same space `Pdf.Rasterizer` produces and a vision model naturally speaks; conversion to PDF user space (points, bottom-left origin) happens inside the controller.

**`modules/image` (new, `@telorun/image`)** — **`Image.Overlay`** (`Telo.Invocable`): image bytes plus a list of labelled rectangles → annotated image bytes, drawn with `@napi-rs/canvas`. Presentation defaults (stroke color/width, label font and placement) are resource config; the image and the shape list are per-invocation inputs. Top-left pixel coordinates, matching the rasterizer. It backs the agent's page previews, but it is a generic vision-grounding primitive (bounding-box visualization for any detection/layout workflow), so it lives in its own module, not in `pdf`.

**`modules/ai` + `modules/ai-openai` (extended)** — images become first-class in both directions of the agent loop:

- *Messages*: `content` becomes `string` **or** an array of content parts — a text part, or an image part `{ type: image, data: <base64>, mediaType }` (provider-neutral). Additive; plain-string messages keep working; `Ai.Text` / `Ai.TextStream` / `Ai.Agent` inputTypes pick up the new shape.
- *Tool results*: the `Ai.ToolProvider` contract's `callTool` may return content parts instead of a plain value; the agent controller carries parts through the `tool` message and the `steps` trace instead of unconditionally JSON-stringifying (`ai-agent-controller.ts`); `Ai.Tools`' `result:` CEL mapping may likewise produce parts. Provider translation owns the transport quirk: OpenAI chat completions cannot carry images in a `tool` message, so `ai-openai`'s `translateMessages` emits the tool message with a short text placeholder plus an immediately following synthetic `user` message carrying the image parts (the documented OpenAI pattern); a future Anthropic provider maps the same parts natively into `tool_result` blocks. The contract stays provider-neutral; only translation differs.
- *Composite tools*: `Ai.Tools`' `tool` slot widens from `x-telo-ref: "telo#Invocable"` to the `anyOf` `telo#Invocable | telo#Runnable` already used by boot-target invoke steps (`analyzer/nodejs/src/builtins.ts`), dispatching through the shared `executeInvokeStep` leaf — so a `Run.Sequence` (a `Telo.Runnable` with callable inputs/outputs) can be wrapped as a tool. The agent's tools here are small sequences composing the primitives.

**`modules/s3` (extended)** — **`S3.PresignedUrl`** (`Telo.Invocable`): bucket ref + object key + expiry → time-limited GET URL.

**`examples/pdf-form-agent` (new)** — the proof. An `Http.Api` POST endpoint accepts a streamed PDF upload, stores it via `S3.Put` under a generated document key, then invokes one `Ai.Agent` whose prompt carries that key. State is split by lifetime: **durable artifacts (input and finalized PDFs) live in S3; the in-progress field set lives in a `Sql.SqliteConnection` with `file: ":memory:"`** — session-scoped scratch state, one shared in-memory database per app process, a `fields` table (documentId, name, type, page, x, y, width, height) created by a `Sql.Exec` boot target. Binary state never rides through the model: it exchanges only document keys, page numbers, field deltas, and images-as-tool-results. Five tools, each a `Run.Sequence` wrapped via `Ai.Tools`:

- `view_page(documentId, page)` — `S3.Get` → `Pdf.Rasterizer` → `Sql.Select` the page's fields → `Image.Overlay` → image part result.
- `add_fields(documentId, page, fields[])` — insert **only the new fields** via `Sql.Exec`, then re-run the view sequence → refreshed page image.
- `update_field(documentId, name, box)` — `Sql.Exec` update (move/resize) → refreshed page image.
- `remove_fields(documentId, names[])` — `Sql.Exec` delete → refreshed page image.
- `finalize_form(documentId)` — `S3.Get` → `Sql.Select` **all** fields → `Pdf.FormFields` → `S3.Put` to the derived output key → text confirmation.

Every mutating tool answers with the refreshed preview of the affected page, so each edit comes with immediate visual feedback in the same tool result. The agent loop (bounded by `maxSteps`) walks the document page by page editing the set; after the agent returns, the endpoint computes `S3.PresignedUrl` for the known output key and responds with the link — no parsing coordinates or URLs out of the model's prose.

**Tests, docs, versioning** (mandatory): per-module tests under `modules/<name>/tests/` with a tiny fixture PDF in `__fixtures__/` (rasterizer dimensions/page-count, form-field round-trip via pdf-lib re-read, overlay pixel smoke); the ai changes test hermetically against the `Ai.EchoModel` fixture (content-part translation, image-bearing tool results through the agent loop, a Runnable wrapped as a tool); the edit-tool sequences test against a `:memory:` SQLite store — no live LLM in tests; the example is the live demo. Docs in `modules/pdf/docs/` and `modules/image/docs/`, updated kind docs for `ai` and `s3`, all wired into `pages/docusaurus.config.ts` + `pages/sidebars.ts`. Changesets for `@telorun/pdf` and `@telorun/image` (new packages), `@telorun/ai`, `@telorun/ai-openai`, `@telorun/s3` (minor, additive), and `@telorun/analyzer` (the widened tool slot); module changie fragments follow from the controller bumps; re-run `scripts/gen-changie-config.mjs` for the two new modules.

## Decisions

- **The loop is the `Ai.Agent` tool loop, not a declarative `Run.Sequence` `while`.** The agent decides when it has converged and what to look at next — that judgment is the point of the exercise, and `Ai.Agent` already owns tool dispatch, step tracing, `maxSteps`, and `onToolError`. A `Run.Sequence` `while` was rejected: it hard-codes the iteration policy in the manifest and was originally motivated only by the images-in-tool-results transport gap, which is closed properly instead (next bullet).
- **Tool results gain content parts at the contract level; providers own the transport quirk.** OpenAI chat completions can't put images in a `tool` message, so `ai-openai` emits placeholder-text tool result + synthetic follow-up `user` message with the images. Handling it in translation (not in the agent loop) keeps `Ai.Agent` provider-agnostic and lets image-native providers (Anthropic `tool_result` blocks) map directly.
- **The model edits the field set; it never carries it.** Tools are deltas (`add_fields` / `update_field` / `remove_fields`) over server-side state, and `finalize_form` takes only the document id. The earlier stateless design — the model re-sending the full field array on every call — was rejected: at 100 pages / 1000 fields it wastes tokens on every iteration and overflows the context window outright.
- **The field set lives in SQLite `:memory:` via the existing `sql` module.** `Sql.SqliteConnection` supports `:memory:` first-class; each edit tool is one SQL statement plus the shared view sequence, and `finalize_form` is a `Sql.Select` feeding `Pdf.FormFields` — fully declarative, zero new modules, and the right lifetime (scratch state dies with the process; durable artifacts are S3's). Rejected: fields-JSON in S3 (read-modify-write per edit needs `JS.Script` or a bespoke merge kind) and a new generic KV/state module (unjustified scope for what `sql` already does).
- **Binary state lives in S3, keyed; the model passes only IDs.** Model arguments are JSON — PDF bytes and rendered pages can't round-trip through them. Tools fetch by `documentId` and return images as result parts, which keeps the tools individually testable.
- **`Ai.Tools` accepts Runnables.** Composite tools (fetch → rasterize → select → overlay) are naturally `Run.Sequence`s; widening the `tool` slot to the existing `Invocable | Runnable` `anyOf` reuses the boot-target precedent rather than inventing per-workflow wrapper kinds.
- **The link is computed outside the agent.** `finalize_form` writes to a key derived from the document key; the endpoint presigns that key after the agent returns. Parsing URLs or coordinates out of model text was rejected — deterministic plumbing stays deterministic.
- **`Image.Overlay` is its own module.** Box drawing is transport-neutral and reusable across vision workflows (breadth rule: generic primitive over use-case shortcut); burying it in `pdf` was rejected.
- **`Pdf.FormFields` exists despite being "for the agent".** The final artifact is a PDF with editable fields — authoring AcroForm fields at coordinates is generic PDF capability any form-generation workflow needs.
- **Names follow the stdlib noun-agent pattern** (`Codec.Encoder`, `Gzip.Encoder`): `Pdf.Rasterizer`, `Pdf.FormFields`, `Image.Overlay`. No `Pdf.ExtractText` — not needed for this goal; additive later if wanted.
- **Libraries: `pdfjs-dist` + `@napi-rs/canvas` (render), `pdf-lib` (write).** pdfjs cannot author fields; pdf-lib cannot render — the split is inherent. Rejected: `mupdf` WASM (AGPL), poppler CLI (system dependency).
- **One coordinate space: rendered-image pixels, top-left origin, parameterized by render scale.** The model, the overlay, and the field writer all speak it; the points/bottom-left flip is a controller-internal detail of `Pdf.FormFields`. Exposing PDF user space to the model was rejected — vision models measure in image pixels.
- **`S3.PresignedUrl` over serving the file through our own GET endpoint** — a generic S3 primitive with no extra serving path to maintain.
- **No http-server changes** — streamed uploads already work via `contentTypeParsers`.

## Example

The heart of the example app (abridged — upload endpoint, S3 wiring, table-bootstrap target, `update_field`/`remove_fields` sequences, and prompts omitted):

```yaml
kind: Sql.SqliteConnection
metadata: { name: FieldStore }
file: ":memory:"                     # session-scoped field set; durable artifacts live in S3
---
kind: Ai.Agent
metadata: { name: FormPlacer }
model: !ref VisionModel
system: |
  Place editable form inputs on the document, page by page. View a page,
  add field boxes for the inputs you see, check the preview, and move or
  remove boxes until every input sits exactly where it belongs — then
  finalize.
maxSteps: 64
toolProviders:
  - provider: !ref FormTools
---
kind: Ai.Tools
metadata: { name: FormTools }
tools:
  - tool: !ref ViewPage              # Run.Sequence below
    name: view_page
    parameters: { … documentId, page … }
    result: "${{ result.image }}"    # image content part back to the model
  - tool: !ref AddFields             # Run.Sequence below
    name: add_fields
    parameters: { … documentId, page, fields[] — only the new ones … }
    result: "${{ result.image }}"
  - tool: !ref UpdateField           # Run.Sequence: Sql.Exec update → ViewPage
    name: update_field
    parameters: { … documentId, name, x, y, width, height … }
    result: "${{ result.image }}"
  - tool: !ref RemoveFields          # Run.Sequence: Sql.Exec delete → ViewPage
    name: remove_fields
    parameters: { … documentId, names[] … }
    result: "${{ result.image }}"
  - tool: !ref FinalizeForm          # Run.Sequence below
    name: finalize_form
    parameters: { … documentId … }
```

The view sequence — render the page, read its current fields from the store,
draw them as labelled boxes. Styling is `Image.Overlay` resource config; the
rows from `Sql.Select` are mapped into rectangles with a CEL `map`:

```yaml
kind: Image.Overlay
metadata: { name: DrawBoxes }
stroke: { color: "#FF3B30", width: 3 }
label: { color: "#FFFFFF", background: "#FF3B30", placement: top-left }
---
kind: Run.Sequence
metadata: { name: ViewPage }
inputs:
  documentId: { type: string }
  page: { type: integer }
steps:
  - name: Fetch
    invoke: !ref GetDocument         # S3.Get
    inputs: { key: "${{ inputs.documentId }}" }
  - name: Page
    invoke: !ref Rasterize           # Pdf.Rasterizer
    inputs:
      data: "${{ steps.Fetch.result.output }}"
      page: "${{ inputs.page }}"
  - name: Fields
    invoke: !ref SelectPageFields    # Sql.Select on FieldStore, filtered by documentId + page
    inputs:
      documentId: "${{ inputs.documentId }}"
      page: "${{ inputs.page }}"
  - name: Marked
    invoke: !ref DrawBoxes
    inputs:
      image: "${{ steps.Page.result.image }}"
      shapes: |-
        ${{ steps.Fields.result.rows.map(f, {
          "x": f.x, "y": f.y, "width": f.width, "height": f.height,
          "label": f.name + " (" + f.type + ")"
        }) }}
outputs:
  image: "${{ steps.Marked.result.image }}"
```

A mutating tool is one SQL statement plus the shared view sequence — the
model's edit and its visual feedback in a single tool call:

```yaml
kind: Run.Sequence
metadata: { name: AddFields }
inputs:
  documentId: { type: string }
  page: { type: integer }
  fields: { type: array, items: { … name, type, x, y, width, height … } }
steps:
  - name: Insert
    invoke: !ref InsertFields        # Sql.Exec multi-row insert on FieldStore
    inputs:
      documentId: "${{ inputs.documentId }}"
      page: "${{ inputs.page }}"
      fields: "${{ inputs.fields }}"
  - name: Preview
    invoke: !ref ViewPage
    inputs:
      documentId: "${{ inputs.documentId }}"
      page: "${{ inputs.page }}"
outputs:
  image: "${{ steps.Preview.result.image }}"
```

The field writer and the finalize sequence. `Pdf.Rasterizer` and
`Pdf.FormFields` are pinned to the same `scale`, so the pixel coordinates the
model measured on the rendered image are the coordinates the writer converts
to PDF user space — one shared coordinate space, no translation in the
manifest:

```yaml
kind: Pdf.Rasterizer
metadata: { name: Rasterize }
scale: 2
---
kind: Pdf.FormFields
metadata: { name: WriteFields }
scale: 2                             # must match Rasterize — coordinates are pixels at this scale
---
kind: Run.Sequence
metadata: { name: FinalizeForm }
inputs:
  documentId: { type: string }
steps:
  - name: Fetch
    invoke: !ref GetDocument         # S3.Get
    inputs: { key: "${{ inputs.documentId }}" }
  - name: AllFields
    invoke: !ref SelectAllFields     # Sql.Select on FieldStore, all pages for documentId
    inputs: { documentId: "${{ inputs.documentId }}" }
  - name: Fielded
    invoke: !ref WriteFields
    inputs:
      data: "${{ steps.Fetch.result.output }}"
      fields: "${{ steps.AllFields.result.rows }}"
  - name: Store
    invoke: !ref PutDocument         # S3.Put, derived output key
    inputs:
      key: "${{ inputs.documentId + '.fields.pdf' }}"
      body: "${{ steps.Fielded.result.data }}"
      contentType: application/pdf
outputs:
  stored: true
```

The POST handler stores the upload, invokes `FormPlacer` with the document key in the prompt, then presigns the derived output key and returns `{ url }`.
