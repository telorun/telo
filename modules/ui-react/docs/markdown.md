# Markdown

A [`markdown` node](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/) draws a string as formatted text,
and so does the chat renderer for a conversation's text: one renderer, shared.
Its `value` is a binding, read like any other bound leaf — `{ value }` for a
fixed string, `{ root, path }` for a path into a root in scope. A path that
reads nothing draws an empty `markdown` part; one that reads a value that is
not a string draws the `error` node `ERR_UI_NODE_INVALID`.

## What is drawn

CommonMark plus GFM tables, task lists, strikethrough and autolinks. Nothing
else is parsed — footnotes, for one, stay literal text.

- **Raw HTML is text.** `<script>` and `<img onerror=…>` appear as the
  characters that were written. The renderer builds elements from the parsed
  text and has no path from it to the document's markup.
- **Links and images are held to the address rule** the `link` node is held
  to: an application path (`/…`, drawn under the mount), `https://`, `http://`
  — and `mailto:` for a link. A link that fails it is its text, without an
  anchor; an image that fails it is its alt text. An `https://` or `http://`
  link opens in a new tab with `rel="noopener noreferrer"`; an application
  link opens in place. An image from another origin is fetched by the viewer's
  browser, with no referrer, once the text is drawn.
- **A task list's boxes** are read-only checkboxes (`role="checkbox"`, `aria-checked`), named by their entry's text: the text is read, not edited.
- **A fenced code block** is highlighted when its info string names a language
  the highlighter knows (the common set: `bash`, `c`, `cpp`, `csharp`, `css`,
  `diff`, `go`, `graphql`, `ini`, `java`, `javascript`, `json`, `kotlin`,
  `less`, `lua`, `makefile`, `markdown`, `objectivec`, `perl`, `php`,
  `python`, `r`, `ruby`, `rust`, `scss`, `shell`, `sql`, `swift`,
  `typescript`, `vbnet`, `wasm`, `xml` (HTML too), `yaml`, and their usual
  aliases). A block with no language, an unknown one, or over 50 000
  characters is drawn plain. The language is shown above the block, beside a
  button copying the block's code to the clipboard; it reads `Copy code`, then
  `Copied` for two seconds — the `chatCopyCode` and `chatCopied` keys of
  [`ui`'s own texts](https://hub.telo.run/module/oci/ghcr.io/telorun/ui/), in the viewer's
  language. A browser that refuses the copy shows the `error` node
  `ERR_UI_COPY_FAILED` beside the button.

## Annotations

A node's `annotations` put a control on the items of the text the server
names: each element of `rows` is `row`, `line` reads the 1-based source line
starting its item, `count` a number drawn as a `badge`, and `action` is the
bound action the control runs — labelled with the action's `label`, run as a
[row action](app.md#row-actions) is, its answer drawn in place of its button
and lasting as long as the rows it was pressed on. The renderer draws exactly
the rows it is given: it finds no item in the text itself.

- A control is drawn on the block holding its line, read from the parser's
  source positions: the list item holding it (the innermost, in a nested
  list), a heading, a paragraph, a quote's own block, a fenced code block, a
  table. A line between two blocks lands on the block after it.
- The controls of one block are drawn together, in the order of `rows`, in a
  `markdown-annotations` element inside the block: at its end, or after the
  first block of a list item, before a nested list.
- A row whose line is past the text, or is not a positive integer, is drawn in
  `markdown-unplaced-annotations` after the text, so none is lost.
- Until the chunk arrives every control is in `markdown-unplaced-annotations`
  under the preformatted text.

## The lazy chunk

The parser and the highlighter are a chunk of the renderer's browser entry of
their own, fetched — by digest, with the entry's other files — when the first
`markdown` node is drawn. Until it arrives the text shows preformatted, in a
`markdown` part whose `data-state` is `loading`; when it has, `idle`. A page
with no `markdown` node never fetches it.

## Drawing it from a component

Inside the renderer, a node that shows Markdown text — the chat's transcript —
draws it with the same component, which fetches the chunk the same way. The
component takes a per-use choice of which images it draws: by default any that
passes the address rule above, and for the [chat's transcript](chat.md) only
those at an app-relative address — an attachment under the endpoint's
`basePath` is one — while an image at any other origin is drawn as its alt
text, since the text is a model's and not the author's. The component ABI
exposes no Markdown to custom components.

## Styling

Every element carries a `markdown-…` [part](styling.md#markdown) — an
annotation's control is a `markdown-annotation` holding a `row-action`, its
`badge` and what a press drew — and the two
attributes `data-level` (a heading's depth) and `data-token` (the kind of a
highlighted run) are listed [states](styling.md#state). Both built-in themes
style them with the existing design tokens alone — the syntax colours are mixed
from `color.accent`, `color.success`, `color.warning`, `color.danger` and
`color.muted`.
