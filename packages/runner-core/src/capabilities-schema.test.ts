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

  it("locks image (only) when enforced; pullPolicy stays editable", () => {
    const schema = sessionConfigSchema({ imageDefault: "telorun/node:latest-slim", enforced: true });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.image.readOnly).toBe(true);
    expect(props.image.default).toBe("telorun/node:latest-slim");
    expect(props.pullPolicy.readOnly).toBeUndefined();
  });

  it("includes registryUrl only when requested", () => {
    const schema = sessionConfigSchema({ imageDefault: "x", registryUrl: true });
    const props = schema.properties as Record<string, unknown>;
    expect(props.registryUrl).toBeDefined();
  });

  it("renders image as an editable enum picker — overriding enforced — when imageEnum is set", () => {
    const schema = sessionConfigSchema({
      imageDefault: "telorun/node:latest-slim",
      enforced: true,
      imageEnum: ["telorun/node:latest-slim", "telorun/node:0.30.1-slim"],
    });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.image.enum).toEqual(["telorun/node:latest-slim", "telorun/node:0.30.1-slim"]);
    expect(props.image.readOnly).toBeUndefined();
    expect(props.image.default).toBe("telorun/node:latest-slim");
    // pullPolicy is a client-editable freshness control.
    expect(props.pullPolicy.readOnly).toBeUndefined();
  });

  it("ignores an empty imageEnum and falls back to the enforced field", () => {
    const schema = sessionConfigSchema({
      imageDefault: "telorun/node:latest-slim",
      enforced: true,
      imageEnum: [],
    });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.image.enum).toBeUndefined();
    expect(props.image.readOnly).toBe(true);
  });
});
