import { RuntimeError } from "@telorun/sdk";

/** What a `Ui.Theme` provides. */
export interface ProvidedTheme {
  tokens: Record<string, string>;
  fonts: Record<string, { family: string; faces: Record<string, Uint8Array | undefined> }>;
}

export interface FontFormat {
  extension: string;
  mediaType: string;
  /** The name CSS knows the format by. */
  css: string;
}

const FORMATS: { magic: number[]; format: FontFormat }[] = [
  { magic: [0x77, 0x4f, 0x46, 0x32], format: { extension: "woff2", mediaType: "font/woff2", css: "woff2" } },
  { magic: [0x77, 0x4f, 0x46, 0x46], format: { extension: "woff", mediaType: "font/woff", css: "woff" } },
  { magic: [0x4f, 0x54, 0x54, 0x4f], format: { extension: "otf", mediaType: "font/otf", css: "opentype" } },
  { magic: [0x00, 0x01, 0x00, 0x00], format: { extension: "ttf", mediaType: "font/ttf", css: "truetype" } },
  { magic: [0x74, 0x72, 0x75, 0x65], format: { extension: "ttf", mediaType: "font/ttf", css: "truetype" } },
];

/** A font file's format, read from its first four bytes. */
export function fontFormat(bytes: Uint8Array): FontFormat | undefined {
  return FORMATS.find(({ magic }) => magic.every((byte, index) => bytes[index] === byte))?.format;
}

const FACES: Record<string, { weight: number; style: string }> = {
  normal: { weight: 400, style: "normal" },
  bold: { weight: 700, style: "normal" },
  italic: { weight: 400, style: "italic" },
  boldItalic: { weight: 700, style: "italic" },
};

const cssString = (text: string) => `"${text.replace(/[\\"]/g, "\\$&").replace(/\n/g, " ")}"`;

/** `color.accent-text` → `--telo-color-accent-text`. */
export function customProperty(token: string): string {
  return `--telo-${token.replaceAll(".", "-")}`;
}

/**
 * A theme as a stylesheet: one `@font-face` per face that has bytes, then the
 * tokens as custom properties in the theme layer. `serveFont` stores a face and
 * answers with the URL it is served at.
 */
export function themeStylesheet(
  theme: ProvidedTheme,
  owner: string,
  serveFont: (name: string, format: FontFormat, bytes: Uint8Array) => string,
): string {
  const faces: string[] = [];
  const declarations: string[] = [];
  const declared = new Set<string>();
  for (const [token, value] of Object.entries(theme.tokens)) {
    declarations.push(`    ${customProperty(token)}: ${value};`);
  }
  for (const [token, font] of Object.entries(theme.fonts)) {
    declarations.push(`    ${customProperty(token)}: ${cssString(font.family)};`);
    for (const [face, bytes] of Object.entries(font.faces)) {
      if (!bytes || declared.has(`${font.family}/${face}`)) continue;
      declared.add(`${font.family}/${face}`);
      const format = fontFormat(bytes);
      if (!format) {
        throw new RuntimeError(
          "ERR_UI_FONT_FORMAT_UNKNOWN",
          `${owner}: the '${face}' face of the '${font.family}' family (theme token '${token}') is not a TrueType, OpenType, WOFF or WOFF2 file, so it cannot be served to a browser.`,
        );
      }
      const slug = font.family.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const url = serveFont(`${slug}-${face}.${format.extension}`, format, bytes);
      const { weight, style } = FACES[face] ?? FACES.normal;
      faces.push(
        `@font-face { font-family: ${cssString(font.family)}; src: url(${cssString(url)}) format("${format.css}"); font-weight: ${weight}; font-style: ${style}; font-display: swap; }`,
      );
    }
  }
  return [...faces, "@layer telo.theme {", "  :root {", ...declarations, "  }", "}", ""].join("\n");
}
