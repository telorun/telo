/**
 * SVG emission.
 *
 * Deliberately a string builder rather than a DOM: there is no DOM here, the
 * output is write-once, and the subset that has to survive pdfmake's renderer
 * is small. Every attribute value and every run of text goes through the
 * escapes below — a category name comes from someone's data, so `&` and `<` in
 * it are the normal case rather than an attack.
 */

const TEXT_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

const ATTR_ESCAPES: Record<string, string> = {
  ...TEXT_ESCAPES,
  '"': "&quot;",
  "'": "&apos;",
};

export function escapeText(value: string): string {
  return value.replace(/[&<>]/g, (char) => TEXT_ESCAPES[char]!);
}

export function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ATTR_ESCAPES[char]!);
}

export type Attrs = Record<string, string | number | undefined>;

function attrs(values: Attrs): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    parts.push(` ${key}="${escapeAttr(typeof value === "number" ? round(value) : value)}"`);
  }
  return parts.join("");
}

/** Coordinates are laid out in floating point and read by a renderer that does
 *  not need the last ten digits. Three decimals is under a thousandth of a
 *  pixel and takes a chart's markup down by about a third. */
export function round(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

export function element(name: string, values: Attrs, children?: string): string {
  const open = `<${name}${attrs(values)}`;
  return children === undefined || children === "" ? `${open}/>` : `${open}>${children}</${name}>`;
}

export function text(content: string, values: Attrs): string {
  return element("text", values, escapeText(content));
}

export function group(values: Attrs, children: string): string {
  return element("g", values, children);
}

/** The document wrapper. `role="img"` plus `<title>` / `<desc>` is the only
 *  thing a screen reader can read, and it matters most here: the visible labels
 *  are text a fallback font may have mangled. */
export function document(opts: {
  width: number;
  height: number;
  title?: string;
  description?: string;
  fontFamily: string;
  fontSize: number;
  body: string;
}): string {
  const head =
    (opts.title ? element("title", {}, escapeText(opts.title)) : "") +
    (opts.description ? element("desc", {}, escapeText(opts.description)) : "");
  return element(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width: opts.width,
      height: opts.height,
      viewBox: `0 0 ${round(opts.width)} ${round(opts.height)}`,
      role: "img",
      "font-family": opts.fontFamily,
      "font-size": opts.fontSize,
    },
    head + opts.body,
  );
}
