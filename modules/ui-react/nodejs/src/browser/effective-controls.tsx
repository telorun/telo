import { Component, createContext, useContext, type ComponentType, type ReactNode } from "react";
import type { ControlName, Controls } from "../contract/ui-react-controls.js";
import { BUILT_IN_CONTROLS } from "./controls/index.js";
import type { RendererEnvironment } from "./renderer-context.js";
import { UiError } from "./ui-error.js";

/** A set of controls a theme supplies: the module, and the controls it implements. */
export interface ControlSetSpec {
  module: string;
  exports: string[];
}

/** The application document's controls: each built-in's mechanics stylesheet in
 *  use, by control, and the sets that replace built-ins. */
export interface ControlsField {
  stylesheets: Record<string, string>;
  sets: ControlSetSpec[];
}

/** The controls an application draws with: each name's component, and the
 *  names whose theme control could not be loaded. */
export interface EffectiveControls {
  components: Controls;
  failures: Partial<Record<ControlName, UiError>>;
}

export const BUILT_IN: EffectiveControls = { components: BUILT_IN_CONTROLS, failures: {} };

export const ControlsContext = createContext<EffectiveControls>(BUILT_IN);

const NAMES = new Set(Object.keys(BUILT_IN_CONTROLS));

/**
 * What gives the control drawn under a name: a theme's where one implements
 * it, else the built-in. A theme's that did not load throws its failure when it
 * is asked for, so it is asked for only where it is drawn, and the boundary of
 * the node drawing it shows it.
 */
export function useControls(): <N extends ControlName>(name: N) => Controls[N] {
  const effective = useContext(ControlsContext);
  return (name) => {
    const failure = effective.failures[name];
    if (failure) throw failure;
    return effective.components[name];
  };
}

/** The control drawn under a name, for a component that always draws it. */
export function useControl<N extends ControlName>(name: N): Controls[N] {
  return useControls()(name);
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What a theme's control that throws is drawn as: its failure, raised to the
 *  boundary of the node that was drawing it. */
class ControlBoundary extends Component<{ name: string; children: ReactNode }, { error?: { reason: string } }> {
  state: { error?: { reason: string } } = {};

  static getDerivedStateFromError(error: unknown) {
    return { error: { reason: reasonOf(error) } };
  }

  render() {
    if (this.state.error) {
      throw new UiError("ERR_UI_THEME_CONTROL_FAILED", `The theme's control '${this.props.name}' failed: ${this.state.error.reason}`);
    }
    return this.props.children;
  }
}

function guarded(name: string, Control: ComponentType<any>): ComponentType<any> {
  const Guarded = (props: Record<string, unknown>) => (
    <ControlBoundary name={name}>
      <Control {...props} />
    </ControlBoundary>
  );
  Guarded.displayName = `ThemeControl(${name})`;
  return Guarded;
}

const isComponent = (candidate: unknown) => typeof candidate === "function" || (typeof candidate === "object" && candidate !== null);

/**
 * Load the control sets an application names, each through the host's module
 * loader. A name no set implements stays the built-in; the first set naming a
 * control is the one drawn. A set that does not load, or lacks a control it
 * names, leaves that control failed rather than built-in.
 */
export async function loadControls(sets: ControlSetSpec[], load: RendererEnvironment["loadModule"]): Promise<EffectiveControls> {
  const loaded = await Promise.all(
    sets.map((set) =>
      load(set.module).then(
        (module) => ({ module }),
        (error: unknown) => ({ error: reasonOf(error) }),
      ),
    ),
  );
  const components: Record<string, ComponentType<any>> = { ...BUILT_IN_CONTROLS };
  const failures: Partial<Record<ControlName, UiError>> = {};
  const taken = new Set<string>();
  sets.forEach((set, index) => {
    const held = loaded[index];
    for (const name of set.exports) {
      if (!NAMES.has(name) || taken.has(name)) continue;
      taken.add(name);
      if ("error" in held) {
        failures[name as ControlName] = new UiError(
          "ERR_UI_THEME_CONTROL_LOAD_FAILED",
          `The theme's control '${name}' could not be loaded from '${set.module}': ${held.error}`,
        );
      } else if (!isComponent(held.module[name])) {
        failures[name as ControlName] = new UiError(
          "ERR_UI_THEME_CONTROL_LOAD_FAILED",
          `The theme's control '${name}' could not be loaded: '${set.module}' exports no control of that name.`,
        );
      } else {
        components[name] = guarded(name, held.module[name] as ComponentType<any>);
      }
    }
  });
  return { components: components as unknown as Controls, failures };
}
