import { describe, expect, it } from "vitest";

import { fileRefusal, perMessageRefusal, uploadMediaType, uploadRefusal } from "../attachment-rules";

const mediaTypes = ["image/png", "application/pdf", "application/json", "application/yaml", "text/*"];
const limits = { maxBytes: 10 * 1024 * 1024, maxPerMessage: 10, mediaTypes };

describe("what a file is uploaded as", () => {
  it("is the browser's type when the agent takes it, else what its extension says", () => {
    expect(uploadMediaType({ name: "shot.png", type: "image/png" }, mediaTypes)).toBe("image/png");
    expect(uploadMediaType({ name: "telo.yaml", type: "" }, mediaTypes)).toBe("application/yaml");
    expect(uploadMediaType({ name: "telo.YML", type: "" }, mediaTypes)).toBe("application/yaml");
    expect(uploadMediaType({ name: "data.json", type: "" }, mediaTypes)).toBe("application/json");
    expect(uploadMediaType({ name: "README.md", type: "" }, mediaTypes)).toBe("text/markdown");
    expect(uploadMediaType({ name: "rows.csv", type: "" }, mediaTypes)).toBe("text/csv");
    for (const name of ["schema.sql", "run.log", "notes.txt"]) {
      expect(uploadMediaType({ name, type: "" }, mediaTypes)).toBe("text/plain");
    }
    expect(uploadMediaType({ name: "schema.sql", type: "application/sql" }, mediaTypes)).toBe("text/plain");
    expect(uploadMediaType({ name: "clip.mov", type: "video/quicktime" }, mediaTypes)).toBe("video/quicktime");
    expect(uploadMediaType({ name: "blob", type: "" }, mediaTypes)).toBe("");
  });
});

describe("a file the capability document rules out", () => {
  it("is refused naming the limit, and `type/*` takes every subtype", () => {
    expect(fileRefusal(limits, { size: 11 * 1024 * 1024, mediaType: "image/png" })).toBe("Larger than the 10 MB limit.");
    expect(fileRefusal(limits, { size: 10, mediaType: "video/quicktime" })).toBe(
      "video/quicktime files are not accepted. Accepted: image/png, application/pdf, application/json, application/yaml, text/*.",
    );
    expect(fileRefusal(limits, { size: 10, mediaType: "text/x-anything" })).toBeNull();
    expect(perMessageRefusal(10)).toBe("A message takes at most 10 files.");
  });
});

describe("an upload the agent refused", () => {
  it("reads in words by its code, with the limit it carries", () => {
    const refused = (code: string, details: Record<string, unknown> = {}) =>
      uploadRefusal({ code, message: `refused (${code})`, details });
    expect(refused("ERR_ATTACHMENT_TOO_LARGE", { maxBytes: 1048576 })).toBe("Larger than the 1 MB limit.");
    expect(refused("ERR_REQUEST_BODY_TOO_LARGE")).toBe("Too large for this agent.");
    expect(refused("ERR_ATTACHMENT_TYPE_NOT_ACCEPTED", { mediaType: "image/tiff", accepted: ["image/png"] })).toBe(
      "image/tiff files are not accepted. Accepted: image/png.",
    );
    expect(refused("ERR_ATTACHMENT_MISLABELLED", { mediaType: "application/zip" })).toBe(
      "Its content is application/zip, which does not match its type.",
    );
    expect(refused("ERR_ATTACHMENT_LIMIT", { max: 100 })).toBe("This conversation already holds 100 files.");
  });
});
