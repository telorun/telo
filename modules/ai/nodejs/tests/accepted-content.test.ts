import { describe, expect, it } from "vitest";
import { requireAccepted, type AcceptedContent } from "../src/accepted-content.js";

const part = (over: Record<string, unknown>) =>
  ({ type: "image", mediaType: "image/png", data: "AAAA", ...over }) as never;

const accepts: AcceptedContent = [
  { type: "image", mediaTypes: ["image/png", "image/jpeg"], maxBytes: 3 },
  { type: "file", mediaTypes: ["application/*"] },
];

describe("requireAccepted", () => {
  it("admits a listed type and media type, ignoring parameters and case", () => {
    expect(() => requireAccepted(accepts, part({ mediaType: "Image/PNG; q=1" }), "m")).not.toThrow();
  });

  it("admits every subtype of a whole-type entry", () => {
    const file = part({ type: "file", mediaType: "application/pdf", uri: "https://x/y", data: undefined });
    expect(() => requireAccepted(accepts, file, "m")).not.toThrow();
  });

  it("refuses an unlisted type and an unlisted media type with the part's identity", () => {
    expect(() => requireAccepted(accepts, part({ type: "audio", mediaType: "audio/mp3" }), "m")).toThrow(
      expect.objectContaining({
        code: "ERR_MODEL_CONTENT_UNSUPPORTED",
        data: { partType: "audio", mediaType: "audio/mp3" },
      }),
    );
    expect(() => requireAccepted(accepts, part({ mediaType: "image/gif" }), "m")).toThrow(
      expect.objectContaining({ code: "ERR_MODEL_CONTENT_UNSUPPORTED" }),
    );
  });

  it("measures bytes, as raw bytes and as base64, and leaves a reference unmeasured", () => {
    expect(() => requireAccepted(accepts, part({ data: new Uint8Array(4) }), "m")).toThrow(
      expect.objectContaining({ code: "ERR_MODEL_CONTENT_UNSUPPORTED" }),
    );
    expect(() => requireAccepted(accepts, part({ data: "AAAA" }), "m")).not.toThrow();
    expect(() => requireAccepted(accepts, part({ data: "AAAAAA==" }), "m")).toThrow();
    expect(() =>
      requireAccepted(accepts, part({ data: undefined, uri: "https://x/y.png" }), "m"),
    ).not.toThrow();
  });

  it("takes text and refuses all media from a model that lists nothing", () => {
    expect(() => requireAccepted([], { type: "text", text: "hi" }, "m")).not.toThrow();
    expect(() => requireAccepted([], part({}), "m")).toThrow();
  });
});
