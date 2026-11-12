import type { ResourceContext } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { modelShape } from "../src/model-schema.js";
import { presented } from "../src/node-resolution.js";

const reader = { ctx: { lookupSchema: () => undefined } as unknown as ResourceContext, owner: "Ui.View 'v'" };
const model = {
  type: "object",
  properties: { note: { type: "string" }, site: { type: "string", format: "uri" } },
};
const timeOf = (member: string) =>
  presented(
    { type: "time", value: { root: "data", path: [member] } },
    { data: modelShape(model, reader, "model") },
    reader,
    "content[0]",
  );

describe("a time node's value", () => {
  it("is refused when it is a string of another format, or of none, naming which", () => {
    expect(() => timeOf("note")).toThrow("'data.note' is a string with no format;");
    expect(() => timeOf("site")).toThrow("'data.site' is a string of format uri;");
  });
});
