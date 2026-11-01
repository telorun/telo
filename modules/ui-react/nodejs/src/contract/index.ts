/**
 * `@telorun/ui-react-contract`: the contract a theme's controls and stylesheets
 * are held to, as data — the part list and states, the reserved properties,
 * the control set of `ui_react_controls-2` with each control's props, parts,
 * states and behaviour vectors, and the scenes that draw every part — and the
 * interpreter that runs the vectors and the scenes in a DOM window — the layout
 * contract `ui_react_layouts-1` with its built-ins' parts and their vectors —
 * and how a design token is spelled as the custom property the page sets.
 */
import controlsData from "./controls.json" with { type: "json" };
import layoutVectorsData from "./layout-vectors.json" with { type: "json" };
import layoutsData from "./layouts.json" with { type: "json" };
import partsData from "./parts.json" with { type: "json" };
import scenesData from "./scenes.json" with { type: "json" };
import vectorsData from "./vectors.json" with { type: "json" };
import type { ControlsContract, ControlVectors, LayoutsContract, Scene } from "./interpreter.js";

/** The part list, the renderer's states, its own part states, the reserved properties and the tokens it reads. */
export interface PartsContract {
  parts: Record<string, string[]>;
  states: Record<string, { values: string[]; on: string[] }>;
  partStates: { values: string[]; on: string[] }[];
  reserved: { part: string; properties: string[]; because: string }[];
  /** The design tokens the renderer's own layer reads: a theme gives each a
   *  value, and need not read it. */
  rendererTokens: string[];
}

export const controls = controlsData as unknown as ControlsContract;
export const parts: PartsContract = partsData;
/** The scenes, with the renderer's words their documents are drawn with. */
export const scenes = scenesData as unknown as { words: Record<string, unknown>; scenes: Scene[] };
export const vectors = vectorsData as unknown as Record<string, ControlVectors>;
/** The layout contract: the props and intents of a layout component, and each built-in's parts. */
export const layouts = layoutsData as unknown as LayoutsContract;
/** Per built-in layout, the props every vector starts from and each behaviour vector. */
export const layoutVectors = layoutVectorsData as unknown as Record<string, ControlVectors>;
export { tokenProperty } from "./token-property.js";
export {
  prepareWindow,
  runLayoutVector,
  runScene,
  runVector,
  withElements,
  type CannedResponse,
  type ControlContract,
  type ControlsContract,
  type ControlVectors,
  type ElementSpec,
  type Expectation,
  type LayoutContract,
  type LayoutsContract,
  type Problem,
  type Scene,
  type SceneHost,
  type Step,
  type Target,
  type Vector,
  type VectorHost,
} from "./interpreter.js";
