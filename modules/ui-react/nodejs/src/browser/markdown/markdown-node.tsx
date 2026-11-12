import { lazy, Suspense, useContext, useEffect, type ReactNode } from "react";
import { readBinding, styleAttribute, type Binding, type Style } from "../bindings.js";
import type { RowActionSpec } from "../operation.js";
import { RootsContext } from "../renderer-context.js";
import { useRowActions } from "../row-actions.js";
import { UiError } from "../ui-error.js";

// The renderer is a chunk of its own, fetched when the first markdown is drawn.
const MarkdownView = lazy(() => import("./markdown-view.js"));

/** Which images a text may draw: any that passes the address rule, or only those at an app-relative address (the chat's transcript, whose text is not the author's). */
export type MarkdownImages = "any" | "app-relative";

/** A control to draw on the block of the text holding `line`, a 1-based source line. */
export interface MarkdownAnnotation {
  line: unknown;
  control: ReactNode;
}

/**
 * Markdown text, drawn as elements. Until the renderer's chunk arrives the
 * text shows preformatted, its annotations after it. Raw HTML in it is text,
 * and a link or an image that fails the address rule is plain text.
 */
export function Markdown({
  source,
  style,
  images = "any",
  fill = false,
  annotations = [],
}: {
  source: string;
  style?: Style;
  images?: MarkdownImages;
  fill?: boolean;
  annotations?: readonly MarkdownAnnotation[];
}) {
  const pending = (
    <div data-telo-part="markdown" data-state="loading" data-fill={fill ? "true" : undefined} data-style={styleAttribute(style)}>
      <pre data-telo-part="markdown-code-pre">{source}</pre>
      {annotations.length > 0 && <div data-telo-part="markdown-unplaced-annotations">{annotations.map((each) => each.control)}</div>}
    </div>
  );
  return (
    <Suspense fallback={pending}>
      <MarkdownView source={source} style={style} images={images} fill={fill} annotations={annotations} />
    </Suspense>
  );
}

/** The items of a text the server names, each with a control running a bound action. */
interface AnnotationsSpec {
  rows: Binding;
  line: Binding;
  count?: Binding;
  action: RowActionSpec;
}

export interface MarkdownNodeSpec {
  value: Binding;
  annotations?: AnnotationsSpec;
  style?: Style;
  fill?: boolean;
}

/**
 * A `markdown` node: its text a binding, nothing drawn while it reads nothing.
 * Each element of its annotations' `rows` is `row`, and puts a control on the
 * block holding its `line`: a button running the bound action over `row` and
 * the roots in scope, with `count` as a badge beside it, drawn as a row action
 * is. An answer lasts as long as the rows it was pressed on.
 */
export function MarkdownNode({ node }: { node: MarkdownNodeSpec }) {
  const roots = useContext(RootsContext);
  const spec = node.annotations;
  const actions = useRowActions(spec ? [spec.action] : [], roots, () => {});
  const read = readBinding(node.value, roots);
  const rows = spec ? readBinding(spec.rows, roots) : undefined;
  const items: unknown[] = rows?.present && Array.isArray(rows.value) ? rows.value : [];
  useEffect(() => actions.clear(), [rows?.present ? rows.value : undefined]);
  const source = read.present ? read.value : "";
  if (typeof source !== "string") {
    throw new UiError("ERR_UI_NODE_INVALID", "A 'markdown' node's value is not a string.");
  }
  const annotations: MarkdownAnnotation[] = spec
    ? items.map((item, index) => {
        const row = (item ?? {}) as Record<string, unknown>;
        const scope = { ...roots, row };
        const line = readBinding(spec.line, scope);
        const count = spec.count === undefined ? undefined : readBinding(spec.count, scope);
        const badge = count?.present && count.value !== null ? <span data-telo-part="badge">{String(count.value)}</span> : null;
        return {
          line: line.present ? line.value : undefined,
          control: (
            <span key={index} data-telo-part="markdown-annotation">
              {actions.control(0, row, String(index), { beside: badge })}
            </span>
          ),
        };
      })
    : [];
  return (
    <>
      <Markdown source={source} style={node.style} fill={node.fill === true} annotations={annotations} />
      {actions.dialog}
    </>
  );
}
