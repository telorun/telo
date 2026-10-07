import { describe, expect, it } from "vitest";
import { fontFormat, themeStylesheet } from "../src/theme-stylesheet.js";

const bytes = (...head: number[]) => new Uint8Array([...head, 0, 0, 0, 0]);
const TTF = bytes(0x00, 0x01, 0x00, 0x00);

describe("a theme's stylesheet", () => {
  it("projects tokens to custom properties and declares each face that has bytes", () => {
    const served: string[] = [];
    const css = themeStylesheet(
      {
        tokens: { "color.accent-text": "#fff", "radius.md": "6px" },
        fonts: {
          "font.body": { family: "Test Sans", faces: { normal: TTF, boldItalic: TTF } },
          "font.mono": { family: "Menlo", faces: {} },
        },
      },
      "UiReact.App 'admin'",
      (name, format) => {
        served.push(`${name} ${format.mediaType}`);
        return `/assets/x/${name}`;
      },
    );
    expect(served).toEqual(["test-sans-normal.ttf font/ttf", "test-sans-boldItalic.ttf font/ttf"]);
    expect(css).toBe(
      [
        '@font-face { font-family: "Test Sans"; src: url("/assets/x/test-sans-normal.ttf") format("truetype"); font-weight: 400; font-style: normal; font-display: swap; }',
        '@font-face { font-family: "Test Sans"; src: url("/assets/x/test-sans-boldItalic.ttf") format("truetype"); font-weight: 700; font-style: italic; font-display: swap; }',
        "@layer telo.theme {",
        "  :root {",
        "    --telo-color-accent-text: #fff;",
        "    --telo-radius-md: 6px;",
        '    --telo-font-body: "Test Sans";',
        '    --telo-font-mono: "Menlo";',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("reads a font's format from its first bytes", () => {
    expect(fontFormat(TTF)?.css).toBe("truetype");
    expect(fontFormat(bytes(0x4f, 0x54, 0x54, 0x4f))?.css).toBe("opentype");
    expect(fontFormat(bytes(0x77, 0x4f, 0x46, 0x46))?.mediaType).toBe("font/woff");
    expect(fontFormat(bytes(0x77, 0x4f, 0x46, 0x32))?.mediaType).toBe("font/woff2");
  });

  it("refuses a face that is no font file a browser reads", () => {
    const theme = { tokens: {}, fonts: { "font.body": { family: "Mystery", faces: { bold: bytes(0x25, 0x50, 0x44, 0x46) } } } };
    expect(() => themeStylesheet(theme, "UiReact.App 'admin'", () => "")).toThrow(
      "UiReact.App 'admin': the 'bold' face of the 'Mystery' family (theme token 'font.body') is not a TrueType, OpenType, WOFF or WOFF2 file",
    );
  });
});
