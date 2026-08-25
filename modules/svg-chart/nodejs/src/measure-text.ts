import { estimateVertical, estimateWidth } from "@telorun/font";
import type { InvokeContext } from "@telorun/sdk";

/**
 * The chart's one text measurement, for the whole layout.
 *
 * A chart knows every string it will draw before it places any of them — the
 * title, both axis titles, every formatted tick, every legend entry, every data
 * label — so the widths come back in ONE call to `Font.Measure`. Measuring per
 * string would put a dispatch on the layout path for each of a hundred ticks.
 *
 * With no `font.metrics` declared there is nothing to dispatch to, so widths
 * come from the same estimator `Font.Measure` itself falls back to, reached
 * through that module's `@telorun/font` entry point rather than copied here.
 */

export interface TextMetrics {
  family: string;
  ascender: number;
  descender: number;
  lineGap: number;
  exact: boolean;
  /** Advance width of `value` at the base size. */
  width(value: string): number;
}

type Dispatch = (
  inputs: Record<string, unknown>,
  invokeCtx?: InvokeContext,
) => Promise<unknown>;

interface MeasureResult {
  family: string;
  widths: number[];
  ascender: number;
  descender: number;
  lineGap: number;
  exact: boolean;
}

/** What the markup names when no family was declared. Every renderer resolves
 *  it, and it is the class of face the estimator's ratios were taken from. */
const DEFAULT_FAMILY = "sans-serif";

export async function measureText(
  strings: Iterable<string>,
  size: number,
  dispatch: Dispatch | undefined,
  invokeCtx?: InvokeContext,
): Promise<TextMetrics> {
  // Deduplicated, because a formatted tick or a repeated series name is the
  // normal case and the measurement is per distinct string.
  const distinct = [...new Set(strings)];

  if (!dispatch) {
    const vertical = estimateVertical(size);
    const cache = new Map(distinct.map((value) => [value, estimateWidth(value, size)]));
    return {
      family: DEFAULT_FAMILY,
      ...vertical,
      exact: false,
      width: (value) => cache.get(value) ?? estimateWidth(value, size),
    };
  }

  const result = (await dispatch({ strings: distinct, size }, invokeCtx)) as MeasureResult;
  const cache = new Map(distinct.map((value, index) => [value, result.widths[index] ?? 0]));
  return {
    family: result.family,
    ascender: result.ascender,
    descender: result.descender,
    lineGap: result.lineGap,
    exact: result.exact,
    // A string the layout asks for after the batch went out was not in it —
    // which is a defect in the caller, not in the data, so it falls back to the
    // estimate rather than failing a render over a label.
    width: (value) => cache.get(value) ?? estimateWidth(value, size),
  };
}
