import type { JSONSchema7 } from "json-schema";
import { describe, expect, it } from "vitest";

import type { RunnerCapabilities } from "../types";
import {
  applySchemaDefaults,
  deprecatedProperties,
  mergeCapabilitySchema,
  withoutDeprecated,
} from "./capability-form";

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
  features: { io: ["tty", "streams"] as const, ports: true, watch: true },
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

describe("a property the runner deprecates", () => {
  const aligned = {
    type: "object",
    required: ["baseUrl", "pullPolicy"],
    properties: {
      baseUrl: { type: "string" },
      image: { type: "string", default: "telorun/node:0-slim", deprecated: true },
      pullPolicy: { type: "string", default: "missing" },
    },
  } as JSONSchema7;

  it("is named, whatever it is called", () => {
    expect(deprecatedProperties(aligned)).toEqual(["image"]);
    expect(deprecatedProperties(caps.config.schema)).toEqual([]);
    expect(deprecatedProperties(undefined)).toEqual([]);
  });

  it("is left out of the settings form", () => {
    const shown = withoutDeprecated(aligned);
    expect(Object.keys(shown.properties ?? {})).toEqual(["baseUrl", "pullPolicy"]);
    expect(shown.required).toEqual(["baseUrl", "pullPolicy"]);
  });

  it("stays on the form of a runner that does not deprecate it", () => {
    const merged = mergeCapabilitySchema(bootstrap, caps);
    expect(Object.keys(withoutDeprecated(merged).properties ?? {})).toEqual([
      "baseUrl",
      "image",
      "pullPolicy",
    ]);
  });

  it("shows again when the runner that answers does not mark what the editor's own copy marks", () => {
    const editorCopy = {
      type: "object",
      properties: { image: { type: "string", deprecated: true } },
    } as JSONSchema7;
    expect(Object.keys(withoutDeprecated(editorCopy).properties ?? {})).toEqual([]);
    const merged = mergeCapabilitySchema(editorCopy, caps);
    expect(Object.keys(withoutDeprecated(merged).properties ?? {})).toEqual(["image", "pullPolicy"]);
  });
});
