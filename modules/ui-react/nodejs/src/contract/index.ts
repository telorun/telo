/**
 * `@telorun/ui-react-contract`: the contract a theme's controls and stylesheets
 * are held to, as data — the part list and states, the reserved properties,
 * the control set of `ui_react_controls-2` with each control's props, parts,
 * states and behaviour vectors, and the scenes that draw every part — and the
 * interpreter that runs the vectors and the scenes in a DOM window — and how a
 * design token is spelled as the custom property the page sets.
 */
import controlsData from "./controls.json" with { type: "json" };
import partsData from "./parts.json" with { type: "json" };
import scenesData from "./scenes.json" with { type: "json" };
import vectorsData from "./vectors.json" with { type: "json" };
import type { ControlsContract, ControlVectors, Scene } from "./interpreter.js";

/** The part list, the renderer's states, its own part states and the reserved properties. */
export interface PartsContract {
  parts: Record<string, string[]>;
  states: Record<string, { values: string[]; on: string[] }>;
  partStates: { values: string[]; on: string[] }[];
  reserved: { part: string; properties: string[]; because: string }[];
}

export const controls = controlsData as unknown as ControlsContract;
export const parts: PartsContract = partsData;
/** The scenes, with the renderer's words their documents are drawn with. */
export const scenes = scenesData as unknown as { words: Record<string, unknown>; scenes: Scene[] };
export const vectors = vectorsData as unknown as Record<string, ControlVectors>;
export { tokenProperty } from "./token-property.js";
export {
  prepareWindow,
  runScene,
  runVector,
  withElements,
  type CannedResponse,
  type ControlContract,
  type ControlsContract,
  type ControlVectors,
  type ElementSpec,
  type Expectation,
  type Problem,
  type Scene,
  type SceneHost,
  type Step,
  type Target,
  type Vector,
  type VectorHost,
} from "./interpreter.js";
