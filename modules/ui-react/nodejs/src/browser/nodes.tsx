import { Component, useContext, type CSSProperties, type ReactNode, type Ref } from "react";
import { conditionHolds, fillAttribute, readBinding, styleAttribute, type Condition, type Style } from "./bindings.js";
import { Action } from "./action.js";
import { Displayed, type ButtonSpec } from "./display-button.js";
import { resolveAddress, type AddressWire } from "./address-wire.js";
import { ChatNode, type ChatNodeSpec } from "./chat/chat-node.js";
import { CommandNode } from "./command-node.js";
import { ComponentNode } from "./component.js";
import { CurrentAnchor } from "./current-location.js";
import { DataNode } from "./data.js";
import { Filters } from "./filters.js";
import { Form } from "./form.js";
import { ControlsContext, useControl } from "./effective-controls.js";
import { useHostStore } from "./host.js";
import { linkAddress } from "./link-address.js";
import { ListView, type ListColumn } from "./list.js";
import { Listing } from "./listing.js";
import type { ActionsSetting } from "./row-actions-display.js";
import { ButtonNode, type ButtonNodeSpec } from "./button-node.js";
import { MarkdownNode, type MarkdownNodeSpec } from "./markdown/markdown-node.js";
import { MenuNode } from "./menu-node.js";
import { RelatedContext, RelatedValue } from "./related-labels.js";
import { EmbeddedContext, RecordLinkContext, RendererContext, RootsContext, underMount, VisibleContext } from "./renderer-context.js";
import { SplitNode, type SplitNodeSpec } from "./split-view.js";
import { TabsNode } from "./tabs-node.js";
import { TimeValue } from "./time-value.js";
import { Presented } from "./value-cell.js";
import { formatOwn, holdsOwn, TextsContext, useSay, useText } from "./texts.js";
import { errorSpec, type ErrorSpec } from "./ui-error.js";

/** A node of a page document. */
export type SpecNode = { type: string; style?: Style; fill?: boolean } & Record<string, any>;

export function ErrorNode({ error }: { error: ErrorSpec }) {
  const texts = useContext(TextsContext);
  // Before the application's texts arrive, what stands for them is shown.
  const message = error.text && holdsOwn(texts, error.text.key) ? formatOwn(texts, error.text.key, error.text.values) : error.message;
  return (
    <div data-telo-part="error" role="alert">
      <ErrorGlyph />
      <span data-telo-part="error-code">{error.code}</span>
      <span data-telo-part="error-message">{message}</span>
    </div>
  );
}

/** What keeps an error node drawable whatever the glyph does. */
class GlyphBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * An error node's glyph. Drawn by a theme's icon that fails, the node would
 * fail drawing its own failure; so it is drawn without one instead, while every
 * other icon of that theme draws the failure where it stands.
 */
function ErrorGlyph() {
  const effective = useContext(ControlsContext);
  if (effective.failures.Icon) return null;
  const Icon = effective.components.Icon;
  return (
    <GlyphBoundary>
      <Icon name="alert" />
    </GlyphBoundary>
  );
}

/** The loading notice; `ref`, `index` and `style` place it as a row of a windowed list. */
export function Loading({ ref, index, style, role = "status" }: { ref?: Ref<HTMLDivElement>; index?: number; style?: CSSProperties; role?: "status" | "presentation" }) {
  const say = useSay();
  const Icon = useControl("Icon");
  return (
    <div data-telo-part="loading" role={role} ref={ref} data-index={index} style={style}>
      <Icon name="loading" />
      {say("loading")}
    </div>
  );
}

export function Nodes({ nodes }: { nodes: SpecNode[] }) {
  return nodes.map((node, index) => <Node key={index} node={node} />);
}

interface NodeBoundaryState {
  node: SpecNode;
  error?: ErrorSpec;
}

/** What keeps one node's failure its own: a node that throws while it is drawn
 *  is replaced by the error node, until the page hands over another node. */
class NodeBoundary extends Component<{ node: SpecNode; children: ReactNode }, NodeBoundaryState> {
  state: NodeBoundaryState = { node: this.props.node };

  static getDerivedStateFromProps(props: { node: SpecNode }, state: NodeBoundaryState): NodeBoundaryState | null {
    return props.node === state.node ? null : { node: props.node, error: undefined };
  }

  static getDerivedStateFromError(error: unknown): Partial<NodeBoundaryState> {
    return { error: errorSpec(error, "ERR_UI_NODE_INVALID") };
  }

  render() {
    return this.state.error ? <ErrorNode error={this.state.error} /> : this.props.children;
  }
}

/** One node, inside a boundary of its own. */
export function Node({ node }: { node: SpecNode }): ReactNode {
  const embedded = useContext(EmbeddedContext);
  const inside = (
    <NodeBoundary node={node}>
      <Drawn node={node} embedded={embedded} />
    </NodeBoundary>
  );
  // Only the node itself is embedded: what it draws beneath is not.
  const drawn = <EmbeddedContext.Provider value={false}>{inside}</EmbeddedContext.Provider>;
  return node.shown === undefined ? drawn : <Shown condition={node.shown as Condition}>{drawn}</Shown>;
}

/**
 * Content a condition decides is drawn. While it does not hold the content
 * stays mounted, out of sight — keeping what it holds — and starts no request.
 */
function Shown({ condition, children }: { condition: Condition; children: ReactNode }) {
  const roots = useContext(RootsContext);
  const visible = useContext(VisibleContext);
  const holds = conditionHolds(condition, roots);
  return (
    <div style={{ display: holds ? "contents" : "none" }}>
      <VisibleContext.Provider value={visible && holds}>{children}</VisibleContext.Provider>
    </div>
  );
}

/** One node, drawn as plain elements carrying the part it is. */
function Drawn({ node, embedded }: { node: SpecNode; embedded: boolean }): ReactNode {
  const store = useHostStore();
  const environment = useContext(RendererContext);
  const roots = useContext(RootsContext);
  const related = useContext(RelatedContext);
  const ofRecord = useContext(RecordLinkContext);
  const text = useText();
  const style = styleAttribute(node.style);
  const fill = fillAttribute(node);
  // An app-relative address is the application's own: it lives under the mount.
  const local = (address: string) => underMount(environment.prefix, address);
  switch (node.type) {
    case "box":
    case "stack":
      return (
        <div data-telo-part={node.type} data-fill={fill} data-style={style}>
          <Nodes nodes={node.children} />
        </div>
      );
    case "bar":
      return (
        <div data-telo-part="bar" data-fill={fill} data-style={style}>
          {(["start", "center", "end"] as const).map((region) => (
            <div key={region} data-telo-part={`bar-${region}`}>
              <Nodes nodes={node[region]} />
            </div>
          ))}
        </div>
      );
    case "command":
      return <CommandNode node={node as unknown as Parameters<typeof CommandNode>[0]["node"]} />;
    case "columns":
      return (
        <div data-telo-part="columns" data-fill={fill} data-style={style}>
          {(node.children as SpecNode[]).map((child, index) => (
            <div key={index} data-telo-part="column">
              <Node node={child} />
            </div>
          ))}
        </div>
      );
    case "text": {
      const names = [node.style ?? []].flat();
      const Element = names.includes("heading") ? "h2" : names.includes("subheading") ? "h3" : "p";
      return (
        <Element data-telo-part="text" data-fill={fill} data-style={style}>
          {text(node.text)}
        </Element>
      );
    }
    case "badge":
      return (
        <span data-telo-part="badge" data-fill={fill} data-style={style}>
          {text(node.text)}
        </span>
      );
    case "link": {
      // An address that does not resolve inside this application, or at all, is plain text.
      const resolved = resolveAddress(node.href as AddressWire, roots, "'link' href");
      const href = resolved === undefined ? undefined : linkAddress(store, resolved);
      if (href === undefined) {
        return (
          <span data-telo-part="text" data-fill={fill} data-style={style}>
            {text(node.text)}
          </span>
        );
      }
      const button = node.button as ButtonSpec | null | undefined;
      if (button == null) {
        return (
          <CurrentAnchor address={resolved} data-telo-part="link" data-record={ofRecord ? "true" : undefined} data-fill={fill} data-style={style} href={href}>
            {text(node.text)}
          </CurrentAnchor>
        );
      }
      return (
        <Displayed display={button} text={text(node.text)} glyph="go">
          <CurrentAnchor address={resolved} data-telo-part="link" data-record={ofRecord ? "true" : undefined} data-button={button.type} data-fill={fill} data-style={style} href={href} />
        </Displayed>
      );
    }
    case "markdown":
      return <MarkdownNode node={node as unknown as MarkdownNodeSpec} />;
    case "menu":
      return <MenuNode node={node} />;
    case "tabs":
      return <TabsNode node={node} />;
    case "image":
      return <img data-telo-part="image" data-fill={fill} data-style={style} src={local(node.src)} alt={text(node.alt)} />;
    case "svg":
      // As an image: markup drawn this way cannot run script or reach the page.
      return (
        <img
          data-telo-part="svg"
          data-fill={fill}
          data-style={style}
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(node.markup)}`}
          alt={text(node.alt)}
        />
      );
    case "value": {
      const read = readBinding(node.value, roots);
      // A record's property with a relation shows the related record's label.
      const relation = node.value.root === "row" && node.value.path.length === 1 ? node.value.path[0] : undefined;
      if (relation !== undefined && related && Object.hasOwn(related.relations, relation)) {
        return (
          <span data-telo-part="value" data-fill={fill} data-style={style}>
            <RelatedValue relation={relation} value={read.present ? read.value : undefined} />
          </span>
        );
      }
      return (
        <span data-telo-part="value" data-fill={fill} data-style={style}>
          <Presented
            value={read.present ? read.value : undefined}
            present={node.present}
            labels={node.labels}
            text={node.text === undefined ? undefined : text(node.text)}
            href={node.href === undefined ? undefined : resolveAddress(node.href as AddressWire, roots, "'value' href")}
          />
        </span>
      );
    }
    case "time": {
      const read = readBinding(node.value, roots);
      return <TimeValue value={read.present ? read.value : undefined} relative={node.relative === true} fill={node.fill === true} style={style} />;
    }
    case "list":
      return (
        <ListView
          heading={node.heading === undefined ? undefined : text(node.heading)}
          rows={node.rows}
          columns={node.columns as ListColumn[]}
          rowStyle={node.rowStyle}
          rowActions={node.rowActions}
          rowActionsDisplay={node.rowActionsDisplay as ActionsSetting}
          style={node.style}
          fill={node.fill === true}
        />
      );
    case "data":
      return <DataNode node={node} />;
    case "listing":
      return <Listing node={node} embedded={embedded} />;
    case "form":
      return <Form node={node} />;
    case "action":
      return <Action node={node} />;
    case "button":
      return <ButtonNode node={node as unknown as ButtonNodeSpec} />;
    case "filters":
      return <Filters node={node} />;
    case "component":
      return <ComponentNode node={node} />;
    case "chat":
      return <ChatNode node={node as unknown as ChatNodeSpec} embedded={embedded} />;
    case "split":
      return <SplitNode node={node as unknown as SplitNodeSpec} />;
    case "error":
      return <ErrorNode error={node as unknown as ErrorSpec} />;
    default:
      return (
        <ErrorNode
          error={{ type: "error", code: "ERR_UI_NODE_INVALID", message: `This renderer does not know a '${node.type}' node.` }}
        />
      );
  }
}
