import type { ResourceDefinition } from "@telorun/sdk";

export const KERNEL_BUILTINS: ResourceDefinition[] = [
  { kind: "Telo.Abstract", metadata: { name: "Template", module: "Telo" } },
  { kind: "Telo.Abstract", metadata: { name: "Runnable", module: "Telo" } },
  { kind: "Telo.Abstract", metadata: { name: "Service", module: "Telo" } },
  { kind: "Telo.Abstract", metadata: { name: "Invocable", module: "Telo" } },
  { kind: "Telo.Abstract", metadata: { name: "Mount", module: "Telo" } },
  { kind: "Telo.Abstract", metadata: { name: "Type", module: "Telo" } },
  {
    kind: "Telo.Abstract",
    metadata: { name: "Provider", module: "Telo" },
    schema: { "x-telo-eval": "compile" },
  },
  {
    kind: "Telo.Definition",
    metadata: { name: "Abstract", module: "Telo" },
    capability: "Telo.Template",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        metadata: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: true,
        },
        capability: { type: "string" },
        schema: { type: "object", additionalProperties: true },
      },
      required: ["metadata"],
      // Telo.Abstract is an extension point by design — it must accept forward-compatible
      // fields (e.g. inputType/outputType from the typed-abstracts plan) without requiring
      // the analyzer to enumerate them here.
      additionalProperties: true,
    },
  },
  {
    kind: "Telo.Definition",
    metadata: { name: "Definition", module: "Telo" },
    capability: "Telo.Template",
    schema: { type: "object" },
  },
  {
    kind: "Telo.Definition",
    metadata: { name: "Import", module: "Telo" },
    capability: "Telo.Template",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        metadata: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: true,
        },
        source: { type: "string" },
        variables: { type: "object" },
        secrets: { type: "object" },
      },
      required: ["metadata", "source"],
      additionalProperties: false,
    },
  },
  {
    kind: "Telo.Definition",
    metadata: { name: "Application", module: "Telo" },
    capability: "Telo.Template",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        metadata: {
          type: "object",
          properties: {
            name: { type: "string" },
            version: { type: "string" },
            source: { type: "string" },
            module: { type: "string" },
          },
          required: ["name"],
          additionalProperties: true,
        },
        lifecycle: {
          type: "string",
          enum: ["shared", "isolated"],
          default: "shared",
        },
        keepAlive: { type: "boolean", default: false },
        targets: {
          type: "array",
          items: {
            anyOf: [
              { type: "string", "x-telo-ref": "telo#Runnable" },
              { type: "string", "x-telo-ref": "telo#Service" },
            ],
          },
        },
        include: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["metadata"],
      additionalProperties: false,
    },
  },
  {
    kind: "Telo.Definition",
    metadata: { name: "Library", module: "Telo" },
    capability: "Telo.Template",
    schema: {
      type: "object",
      properties: {
        kind: { type: "string" },
        metadata: {
          type: "object",
          properties: {
            name: { type: "string" },
            version: { type: "string" },
            source: { type: "string" },
            module: { type: "string" },
          },
          required: ["name"],
          additionalProperties: true,
        },
        variables: { type: "object" },
        secrets: { type: "object" },
        include: {
          type: "array",
          items: { type: "string" },
        },
        exports: {
          type: "object",
          properties: {
            kinds: { type: "array", items: { type: "string" } },
          },
          additionalProperties: true,
        },
      },
      required: ["metadata"],
      additionalProperties: false,
    },
  },
];
