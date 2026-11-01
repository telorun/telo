import { Component, lazy, Suspense, useContext, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { resolveBinding, styleAttribute, type Binding } from "./bindings.js";
import { ErrorNode, Loading, type SpecNode } from "./nodes.js";
import { assetUrl, RendererContext, RowContext, type RendererEnvironment } from "./renderer-context.js";
import { errorSpec, UiError, type ErrorSpec } from "./ui-error.js";

type Loader = RendererEnvironment["loadModule"];

/** One lazy component per module and export, so the same node keeps the same
 *  component — and what it holds — across renders. */
const loaded = new WeakMap<Loader, Map<string, ComponentType<any>>>();

function componentFor(load: Loader, url: string, name: string): ComponentType<any> {
  const known = loaded.get(load) ?? new Map<string, ComponentType<any>>();
  loaded.set(load, known);
  const key = `${url}#${name}`;
  let component = known.get(key);
  if (!component) {
    component = lazy(async () => {
      let module: Record<string, unknown>;
      try {
        module = await load(url);
      } catch (error) {
        throw new UiError(
          "ERR_UI_COMPONENT_LOAD_FAILED",
          `The component '${name}' could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (typeof module[name] !== "function") {
        throw new UiError("ERR_UI_COMPONENT_EXPORT_MISSING", `The loaded module has no component exported as '${name}'.`);
      }
      return { default: module[name] as ComponentType<any> };
    });
    known.set(key, component);
  }
  return component;
}

/** A component's stylesheet joins the page once, in the component layer. */
function attachStylesheet(url: string): void {
  for (const style of document.head.querySelectorAll("style[data-telo-component-style]")) {
    if (style.getAttribute("data-telo-component-style") === url) return;
  }
  const style = document.createElement("style");
  style.setAttribute("data-telo-component-style", url);
  style.textContent = `@import url(${JSON.stringify(url)}) layer(telo.component);`;
  document.head.append(style);
}

class Boundary extends Component<{ onError: () => void; children: ReactNode }, { error?: ErrorSpec }> {
  state: { error?: ErrorSpec } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error: errorSpec(error, "ERR_UI_COMPONENT_FAILED") };
  }

  componentDidCatch() {
    this.props.onError();
  }

  render() {
    return this.state.error ? <ErrorNode error={this.state.error} /> : this.props.children;
  }
}

function Mounted({ onMounted }: { onMounted: () => void }) {
  useEffect(onMounted, []);
  return null;
}

/** A component module's export, drawn with these props inside an error boundary and a suspense boundary of its own. */
export function LoadedComponent({
  module,
  name,
  stylesheets,
  style,
  props,
}: {
  module: { digest: string; name: string };
  name: string;
  stylesheets: { digest: string; name: string }[];
  style?: string;
  props: Record<string, unknown>;
}) {
  const environment = useContext(RendererContext);
  const [state, setState] = useState<"loading" | "idle" | "error">("loading");
  const url = assetUrl(environment, module);
  const Loaded = componentFor(environment.loadModule, url, name);
  const sheets = stylesheets.map((sheet) => assetUrl(environment, sheet));
  useEffect(() => sheets.forEach(attachStylesheet), [sheets.join("\n")]);
  return (
    <div data-telo-part="component" data-state={state} data-style={style}>
      <Boundary key={`${url}#${name}`} onError={() => setState("error")}>
        <Suspense fallback={<Loading />}>
          <Loaded {...props} />
          <Mounted onMounted={() => setState("idle")} />
        </Suspense>
      </Boundary>
    </div>
  );
}

/**
 * A custom component: loaded once, given exactly its declared properties —
 * those bound to a row resolved against the row it is drawn for.
 */
export function ComponentNode({ node }: { node: SpecNode }) {
  const row = useContext(RowContext);
  const props: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(node.props as Record<string, Binding>)) {
    props[name] = resolveBinding(binding, { row });
  }
  return <LoadedComponent module={node.module} name={node.export} stylesheets={node.stylesheets} style={styleAttribute(node.style)} props={props} />;
}
