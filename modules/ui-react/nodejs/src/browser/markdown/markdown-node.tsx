import { lazy, Suspense, useContext } from "react";
import { readBinding, styleAttribute, type Binding, type Style } from "../bindings.js";
import { RootsContext } from "../renderer-context.js";
import { UiError } from "../ui-error.js";

// The renderer is a chunk of its own, fetched when the first markdown is drawn.
const MarkdownView = lazy(() => import("./markdown-view.js"));

/** Which images a text may draw: any that passes the address rule, or only those at an app-relative address (the chat's transcript, whose text is not the author's). */
export type MarkdownImages = "any" | "app-relative";

/**
 * Markdown text, drawn as elements. Until the renderer's chunk arrives the
 * text shows preformatted. Raw HTML in it is text, and a link or an image
 * that fails the address rule is plain text.
 */
export function Markdown({ source, style, images = "any", fill = false }: { source: string; style?: Style; images?: MarkdownImages; fill?: boolean }) {
  const pending = (
    <div data-telo-part="markdown" data-state="loading" data-fill={fill ? "true" : undefined} data-style={styleAttribute(style)}>
      <pre data-telo-part="markdown-code-pre">{source}</pre>
    </div>
  );
  return (
    <Suspense fallback={pending}>
      <MarkdownView source={source} style={style} images={images} fill={fill} />
    </Suspense>
  );
}

/** A `markdown` node: its text a binding, nothing drawn while it reads nothing. */
export function MarkdownNode({ node }: { node: { text: Binding; style?: Style; fill?: boolean } }) {
  const roots = useContext(RootsContext);
  const read = readBinding(node.text, roots);
  const source = read.present ? read.value : "";
  if (typeof source !== "string") {
    throw new UiError("ERR_UI_NODE_INVALID", "A 'markdown' node's text is not a string.");
  }
  return <Markdown source={source} style={node.style} fill={node.fill === true} />;
}
