import { describe, expect, it } from "vitest";

import { sessionConfigSchema } from "./capabilities-schema.js";

describe("sessionConfigSchema", () => {
  it("advertises editable image/pullPolicy with defaults", () => {
    const schema = sessionConfigSchema({ imageDefault: "telorun/node:0-slim" });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.image.default).toBe("telorun/node:0-slim");
    expect(props.image.readOnly).toBeUndefined();
    expect(props.pullPolicy.default).toBe("missing");
    expect(props.registryUrl).toBeUndefined();
    expect(schema.required).toEqual(["image", "pullPolicy"]);
  });

  it("marks image/pullPolicy readOnly when enforced", () => {
    const schema = sessionConfigSchema({ imageDefault: "telorun/node:latest-slim", enforced: true });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.image.readOnly).toBe(true);
    expect(props.image.default).toBe("telorun/node:latest-slim");
    expect(props.pullPolicy.readOnly).toBe(true);
  });

  it("includes registryUrl only when requested", () => {
    const schema = sessionConfigSchema({ imageDefault: "x", registryUrl: true });
    const props = schema.properties as Record<string, unknown>;
    expect(props.registryUrl).toBeDefined();
  });
});
