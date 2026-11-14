import { useAside, type AsideSpec } from "./aside.js";
import { fillAttribute, styleAttribute, type Style } from "./bindings.js";
import { Node, type SpecNode } from "./nodes.js";
import { EmbeddedContext, RendererContext } from "./renderer-context.js";
import { useContext } from "react";

/** The `split` node of a page document: every member present. */
export interface SplitNodeSpec {
  aside: AsideSpec;
  content: SpecNode;
  style?: Style;
  fill?: boolean;
}

/** An aside beside its content; the aside is the one a page layout draws too. */
export function SplitNode({ node }: { node: SplitNodeSpec }) {
  const { compact: narrow } = useContext(RendererContext);
  const fill = fillAttribute(node);
  const aside = useAside(node.aside, fill);
  if (aside === undefined) return null;
  const { side } = node.aside;
  return (
    <div data-telo-part="split" data-side={side} data-state={aside.state} data-frame={node.aside.frame} data-fill={fill} data-style={styleAttribute(node.style)}>
      {!narrow && side !== "end" && aside.place()}
      {side !== "end" && aside.rail}
      <div data-telo-part="split-content" data-fill={fill}>
        <EmbeddedContext.Provider value={aside.flush}>
          <Node node={node.content} />
        </EmbeddedContext.Provider>
      </div>
      {!narrow && side === "end" && aside.place()}
      {side === "end" && aside.rail}
      {aside.mounted}
    </div>
  );
}
