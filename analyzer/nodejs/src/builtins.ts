import type { ResourceDefinition } from "@telorun/sdk";

export const KERNEL_BUILTINS: ResourceDefinition[] = [
  { kind: "Kernel.Abstract", metadata: { name: "Template", module: "Kernel" } },
  { kind: "Kernel.Abstract", metadata: { name: "Runnable", module: "Kernel" } },
  { kind: "Kernel.Abstract", metadata: { name: "Service", module: "Kernel" } },
  { kind: "Kernel.Abstract", metadata: { name: "Invocable", module: "Kernel" } },
  { kind: "Kernel.Abstract", metadata: { name: "Mount", module: "Kernel" } },
  { kind: "Kernel.Abstract", metadata: { name: "Type", module: "Kernel" } },
  {
    kind: "Kernel.Abstract",
    metadata: { name: "Provider", module: "Kernel" },
    schema: { "x-telo-eval": "compile" },
  },
  {
    kind: "Kernel.Definition",
    metadata: { name: "Abstract", module: "Kernel" },
    capability: "Kernel.Template",
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
      },
      required: ["metadata"],
      additionalProperties: false,
    },
  },
  {
    kind: "Kernel.Definition",
    metadata: { name: "Definition", module: "Kernel" },
    capability: "Kernel.Template",
    schema: { type: "object" },
  },
  {
    kind: "Kernel.Definition",
    metadata: { name: "Import", module: "Kernel" },
    capability: "Kernel.Template",
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
    kind: "Kernel.Definition",
    metadata: { name: "Module", module: "Kernel" },
    capability: "Kernel.Template",
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
        variables: { type: "object" },
        secrets: { type: "object" },
        targets: {
          type: "array",
          items: {
            anyOf: [
              { type: "string", "x-telo-ref": "kernel#Runnable" },
              { type: "string", "x-telo-ref": "kernel#Service" },
            ],
          },
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
