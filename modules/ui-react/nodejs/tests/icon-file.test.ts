import { describe, expect, it } from "vitest";
import { servedIconFormat } from "../src/icon-file.js";

const text = (source: string) => new TextEncoder().encode(source);

describe("an icon's file", () => {
  it("is served as the SVG, PNG or WebP image its own bytes say it is, and refused as anything else", () => {
    const format = (bytes: Uint8Array) => servedIconFormat(bytes, "/icons/x", "UiReact.App 'admin'", "navigation.items[0].icon").mediaType;
    expect(format(text('<!-- @license lucide-static v1.8.0 - ISC -->\n<svg\n  class="lucide" xmlns="http://www.w3.org/2000/svg">\n</svg>'))).toBe("image/svg+xml");
    expect(format(text('<?xml version="1.0"?>\n<!DOCTYPE svg>\n<svg viewBox="0 0 1 1"/>'))).toBe("image/svg+xml");
    expect(format(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(format(new Uint8Array([...text("RIFF"), 0, 0, 0, 0, ...text("WEBPVP8 ")]))).toBe("image/webp");
    expect(() => format(text("<html><svg></svg></html>"))).toThrow(
      expect.objectContaining({
        code: "ERR_UI_ICON_FORMAT_UNKNOWN",
        message:
          "UiReact.App 'admin': the icon of 'navigation.items[0].icon' is drawn from '/icons/x', which is not an SVG, PNG or WebP image, so a browser cannot draw it as a glyph. Point the icon at an SVG, PNG or WebP file.",
      }),
    );
  });
});
