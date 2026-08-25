/**
 * The default categorical scale.
 *
 * Okabe–Ito: eight hues chosen to stay distinguishable under the three common
 * forms of colour blindness. A chart from this module usually lands somewhere
 * nobody re-themes — a PDF report, an email, a generated page — so the default
 * is what most output actually renders with, and a scale that fails for one
 * reader in twelve is not a defensible one to pick.
 *
 * Cycled when a chart has more series than colours. The wrap is documented
 * rather than hidden: with nine or more series the legend is what tells them
 * apart, and no eight-colour scale can do better.
 */
export const OKABE_ITO = [
  "#0072B2", // blue
  "#E69F00", // orange
  "#009E73", // bluish green
  "#CC79A7", // reddish purple
  "#56B4E9", // sky blue
  "#D55E00", // vermillion
  "#F0E442", // yellow
  "#000000", // black
];

export function paletteFor(declared: string[] | undefined): (index: number) => string {
  const colors = declared?.length ? declared : OKABE_ITO;
  return (index) => colors[((index % colors.length) + colors.length) % colors.length]!;
}

/** Axis rules, gridlines and label text, in one place so a chart reads as one
 *  drawing rather than as marks over unrelated furniture. */
export const INK = {
  axis: "#6B7280",
  grid: "#E5E7EB",
  text: "#111827",
  mutedText: "#6B7280",
};
