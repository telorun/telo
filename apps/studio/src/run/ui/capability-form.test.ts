import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";

import type { RunnerCapabilities } from "../types";
import { applySchemaDefaults, mergeCapabilitySchema } from "./capability-form";

const bootstrap: JSONSchema7 = {
  type: "object",
  required: ["baseUrl"],
  properties: { baseUrl: { type: "string" } },
};

const caps: RunnerCapabilities = {
  displayName: "Docker runner",
  description: "",
  config: {
    schema: {
      type: "object",
      required: ["image", "pullPolicy"],
      properties: {
        image: { type: "string", default: "telorun/node:0-slim" },
        pullPolicy: { type: "string", default: "missing" },
      },
    },
  },
  features: { io: true, ports: true },
};

describe("mergeCapabilitySchema", () => {
  it("returns the bootstrap schema unchanged when there are no capabilities", () => {
    expect(mergeCapabilitySchema(bootstrap, null)).toEqual(bootstrap);
  });

  it("merges advertised fields and unions required keys", () => {
    const merged = mergeCapabilitySchema(bootstrap, caps);
    expect(Object.keys(merged.properties ?? {})).toEqual(["baseUrl", "image", "pullPolicy"]);
    expect(merged.required).toEqual(["baseUrl", "image", "pullPolicy"]);
  });
});

describe("applySchemaDefaults", () => {
  it("fills missing keys from defaults without clobbering existing values", () => {
    const seeded = applySchemaDefaults(caps.config.schema, { baseUrl: "x", image: "custom" });
    expect(seeded.image).toBe("custom");
    expect(seeded.pullPolicy).toBe("missing");
    expect(seeded.baseUrl).toBe("x");
  });

  it("lets a readOnly (enforced) default override a stale existing value", () => {
    const enforced: JSONSchema7 = {
      type: "object",
      properties: {
        image: { type: "string", default: "telorun/node:latest-slim", readOnly: true },
      },
    };
    // A stale docker image carried over from a previous runner must not survive
    // onto an enforced field.
    const seeded = applySchemaDefaults(enforced, { image: "telorun/telo:nodejs" });
    expect(seeded.image).toBe("telorun/node:latest-slim");
  });
});
