/**
 * The declared shape of every chart, as the controllers read it.
 *
 * One file because the levels are one inheritance chain in the manifest: what
 * `SvgChart.Chart` declares is what every controller reads, and what
 * `SvgChart.Cartesian` adds is what four of them read.
 */

/** An unevaluated CEL accessor, expanded per row. */
export type Accessor = unknown;

export interface FontConfig {
  size?: number;
  metrics?: unknown;
}

export interface LegendConfig {
  placement?: "right" | "bottom" | "none";
  title?: string;
}

export interface LabelsConfig {
  format?: string;
  valueFormat?: string;
}

export interface Margin {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface ChartResource {
  metadata: { name: string; module?: string };
  rows: unknown;
  title?: string;
  description?: string;
  width?: number;
  height?: number;
  margin?: Margin;
  palette?: string[];
  locale?: string;
  font?: FontConfig;
  legend?: LegendConfig;
}

/** Declared only by the kinds that draw a label on a mark. `Area` has none: a
 *  filled band has no per-mark anchor a label reads against, and one at every
 *  vertex is noise. */
export interface Labelled {
  labels?: LabelsConfig;
}

export type ScaleKind = "linear" | "log" | "time" | "band" | "point";

export interface AxisConfig {
  value: Accessor;
  scale?: ScaleKind;
  domain?: { min?: number; max?: number };
  title?: string;
  tickFormat?: string;
  ticks?: number;
}

export interface CartesianResource extends ChartResource {
  x: AxisConfig;
  y: AxisConfig;
  series?: Accessor;
  gridlines?: { x?: boolean; y?: boolean };
}

export interface PieResource extends ChartResource, Labelled {
  category: Accessor;
  value: Accessor;
  innerRadius?: number;
}

export interface BarResource extends CartesianResource, Labelled {
  stacked?: boolean;
  orientation?: "vertical" | "horizontal";
}

export interface LineResource extends CartesianResource, Labelled {
  curve?: CurveName;
  points?: boolean;
  strokeWidth?: number;
}

export interface AreaResource extends CartesianResource {
  curve?: CurveName;
  stacked?: boolean;
  fillOpacity?: number;
}

export interface ScatterResource extends CartesianResource, Labelled {
  size?: { value: Accessor; range?: [number, number] };
  radius?: number;
}

export type CurveName = "linear" | "monotone" | "step" | "natural" | "basis";

export const MEDIA_TYPE = "image/svg+xml";

export interface ChartOutput {
  svg: string;
  width: number;
  height: number;
  mediaType: string;
}

/** Every dimension a chart needs before it can place anything, with the
 *  declared defaults applied once rather than at each reader. */
export interface Canvas {
  width: number;
  height: number;
  margin: Required<Margin>;
  fontSize: number;
}

export function readCanvas(resource: ChartResource): Canvas {
  return {
    width: resource.width ?? 640,
    height: resource.height ?? 360,
    margin: {
      top: resource.margin?.top ?? 12,
      right: resource.margin?.right ?? 12,
      bottom: resource.margin?.bottom ?? 12,
      left: resource.margin?.left ?? 12,
    },
    fontSize: resource.font?.size ?? 12,
  };
}
