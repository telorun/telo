import { makeTaggedSentinel } from "@telorun/templating";
import { describe, expect, it } from "vitest";
import { resolveEdgeInputs } from "./edge-inputs";

const serverSchema = {
  type: "object",
  properties: {
    notFoundHandler: {
      type: "object",
      properties: {
        invoke: { "x-telo-ref": "telo#Invocable" },
        inputs: { type: "object", additionalProperties: true },
      },
    },
    mounts: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, type: { "x-telo-ref": "telo#Mount" } },
      },
    },
  },
};

const routesSchema = {
  type: "object",
  properties: {
    routes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          handler: { "x-telo-ref": "telo#Invocable" },
          inputs: { type: "object", additionalProperties: true },
        },
      },
    },
  },
};

// `targets`-style array whose item is an anyOf of bare ref | inline invoke.
const targetsSchema = {
  type: "object",
  properties: {
    targets: {
      type: "array",
      items: {
        anyOf: [
          { type: "string", "x-telo-ref": "telo#Runnable" },
          {
            type: "object",
            properties: {
              invoke: { "x-telo-ref": "telo#Invocable" },
              inputs: { type: "object", additionalProperties: true },
            },
          },
        ],
      },
    },
  },
};

describe("resolveEdgeInputs", () => {
  it("resolves the parent inputs of a dispatch-suffixed ref", () => {
    const found = resolveEdgeInputs(
      serverSchema,
      { notFoundHandler: { invoke: { kind: "x.Y", name: "h" } } },
      "notFoundHandler.invoke",
    );
    expect(found?.pointer).toBe("/notFoundHandler/inputs");
  });

  it("resolves inputs for a ref inside an array of objects", () => {
    const found = resolveEdgeInputs(
      routesSchema,
      { routes: [{ handler: { kind: "x.Y", name: "h" } }] },
      "routes[0].handler",
    );
    expect(found?.pointer).toBe("/routes/0/inputs");
  });

  it("returns null when the invocation object declares no inputs sibling", () => {
    const found = resolveEdgeInputs(
      serverSchema,
      { mounts: [{ type: { kind: "x.Api", name: "a" } }] },
      "mounts[0].type",
    );
    expect(found).toBeNull();
  });

  it("resolves inputs of an inline array step (anyOf invoke branch)", () => {
    const found = resolveEdgeInputs(
      targetsSchema,
      { targets: [{ invoke: { kind: "x.Y", name: "a" }, inputs: {} }] },
      "targets[0]",
    );
    expect(found?.pointer).toBe("/targets/0/inputs");
  });

  it("returns null for a bare ref array item (no inputs)", () => {
    const found = resolveEdgeInputs(
      targetsSchema,
      { targets: [makeTaggedSentinel("ref", "w")] },
      "targets[0]",
    );
    expect(found).toBeNull();
  });
});
