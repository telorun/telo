/** How wide content is drawn, as `Ui.PageWidth` spells it. */
export type PageWidth = "contained" | "full";

/**
 * The one reading of a `Ui.PageWidth` chain: the value written where it
 * applies, else the application's `pageWidth`, else `contained`. A value
 * holding nothing counts as omitted.
 */
export function resolvedPageWidth(own: PageWidth | null | undefined, application: PageWidth | null | undefined): PageWidth {
  return own ?? application ?? "contained";
}
