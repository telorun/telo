import { describe, expect, it } from "vitest";

import {
  containerConfig,
  optionalContainerConfig,
  sessionConfigSchema,
  validateContainerConfig,
  validateOptionalContainerConfig,
} from "./container-config.js";

describe("sessionConfigSchema", () => {
  it("advertises editable image/pullPolicy with defaults", () => {
    const schema = sessionConfigSchema({ imageDefault: "telorun/node:0-slim" });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.image.default).toBe("telorun/node:0-slim");
    expect(props.image.readOnly).toBeUndefined();
    expect(props.pullPolicy.default).toBe("missing");
    expect(schema.required).toEqual(["image", "pullPolicy"]);
  });

  it("locks image (only) when enforced; pullPolicy stays editable", () => {
    const schema = sessionConfigSchema({ imageDefault: "telorun/node:latest-slim", enforced: true });
    const props = schema.properties as Record<string, Record<string, unknown>>;
    expect(props.image.readOnly).toBe(true);
    expect(props.image.default).toBe("telorun/node:latest-slim");
    expect(props.pullPolicy.readOnly).toBeUndefined();
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

describe("validateContainerConfig", () => {
  it("names the missing image rather than letting the start fail later", () => {
    expect(validateContainerConfig({})).toMatch(/config\.image/);
    expect(validateContainerConfig({ image: "   " })).toMatch(/config\.image/);
  });

  it("rejects an unknown pull policy", () => {
    expect(validateContainerConfig({ image: "telorun/node:0-slim", pullPolicy: "sometimes" })).toMatch(
      /pullPolicy/,
    );
  });

  it("accepts a config with only an image, defaulting the policy", () => {
    expect(validateContainerConfig({ image: "telorun/node:0-slim" })).toBeUndefined();
    expect(containerConfig({ image: "telorun/node:0-slim" })).toEqual({
      image: "telorun/node:0-slim",
      pullPolicy: "missing",
    });
  });

  it("throws when a backend reaches it with a config no gate refused", () => {
    expect(() => containerConfig({})).toThrow(/config\.image/);
  });
});

describe("validateOptionalContainerConfig", () => {
  it("accepts an absent image — the runner supplies its own default", () => {
    expect(validateOptionalContainerConfig({})).toBeUndefined();
    expect(optionalContainerConfig({})).toEqual({ image: undefined, pullPolicy: "missing" });
  });

  it("refuses a present-but-unusable image instead of falling back to the default", () => {
    // Coercing this to `undefined` started a pod on the operator's default
    // image and told nobody.
    expect(validateOptionalContainerConfig({ image: 42 })).toMatch(/config\.image/);
    expect(validateOptionalContainerConfig({ image: "  " })).toMatch(/config\.image/);
  });

  it("refuses an unknown pull policy instead of coercing it to `missing`", () => {
    expect(validateOptionalContainerConfig({ pullPolicy: "sometimes" })).toMatch(/pullPolicy/);
    expect(() => optionalContainerConfig({ pullPolicy: "sometimes" })).toThrow(/pullPolicy/);
  });
});
