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
    // Top-level shape stays open (`additionalProperties: true`) so this change
    // attaches x-telo-context annotations to known template-body fields without
    // tightening the Telo.Definition shape itself. The annotations drive
    // static CEL validation of expressions inside `resources:` / `invoke:` /
    // `run:` / `provide:` / top-level `inputs:` / top-level `result:` against
    // `self` (typed from `schema:`) and `inputs` (typed from `inputType:`,
    // falling back to the extends-declared abstract).
    //
    // `inputs:` and `result:` live as top-level siblings of `invoke:` / `provide:`,
    // matching how Run.Sequence steps factor dispatch from data. The dispatch
    // entry-point (`invoke` / `provide` / `run`) determines how `inputs`/`result`
    // are interpreted at runtime. See analyzer/nodejs/plans/template-internal-cel-validation.md.
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        resources: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            "x-telo-context": {
              type: "object",
              additionalProperties: false,
              properties: {
                self: { "x-telo-context-from-root": "schema" },
                inputs: { "x-telo-context-from-root": "inputType" },
              },
            },
          },
        },
        invoke: {
          oneOf: [
            {
              type: "string",
              "x-telo-context": {
                type: "object",
                additionalProperties: false,
                properties: {
                  self: { "x-telo-context-from-root": "schema" },
                },
              },
            },
            {
              type: "object",
              additionalProperties: true,
              properties: {
                kind: { type: "string" },
                name: {
                  type: "string",
                  "x-telo-context": {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      self: { "x-telo-context-from-root": "schema" },
                    },
                  },
                },
              },
            },
          ],
        },
        provide: {
          type: "object",
          additionalProperties: true,
          properties: {
            kind: { type: "string" },
            name: {
              type: "string",
              "x-telo-context": {
                type: "object",
                additionalProperties: false,
                properties: {
                  self: { "x-telo-context-from-root": "schema" },
                },
              },
            },
          },
        },
        run: {
          type: "string",
          "x-telo-context": {
            type: "object",
            additionalProperties: false,
            properties: {
              self: { "x-telo-context-from-root": "schema" },
            },
          },
        },
        inputs: {
          type: "object",
          additionalProperties: true,
          "x-telo-context": {
            type: "object",
            additionalProperties: false,
            properties: {
              self: { "x-telo-context-from-root": "schema" },
              inputs: { "x-telo-context-from-root": "inputType" },
            },
          },
        },
        result: {
          type: "object",
          additionalProperties: true,
          "x-telo-context": {
            type: "object",
            additionalProperties: false,
            properties: {
              self: { "x-telo-context-from-root": "schema" },
              result: {
                "x-telo-context-from-ref-kind": [
                  "provide/kind#outputType",
                  "invoke/kind#outputType",
                ],
              },
            },
          },
        },
      },
    },
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
        runtime: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
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
              // Post-resolution shape that `resolveRefSentinels`
              // substitutes a `!ref <name>` sentinel into. The
              // adjacent `x-telo-ref` constraints govern the kind
              // check; this branch only admits the structural form so
              // AJV doesn't reject a resolved ref.
              {
                type: "object",
                required: ["kind", "name"],
                properties: {
                  kind: { type: "string" },
                  name: { type: "string" },
                },
                additionalProperties: true,
              },
            ],
          },
        },
        include: {
          type: "array",
          items: { type: "string" },
        },
        // Application-level environment contract. Each entry layers `env:`
        // (required, names the source env var) and `default:` (optional, used
        // when the env var is unset) on top of an open JSON Schema property
        // schema. `type:` constrains the coercion rule applied to the raw env
        // string (scalars per-type; `object` / `array` via JSON.parse with the
        // matching top-level type). All other JSON Schema keywords are passed
        // through unchanged and applied to the coerced value via the standard
        // schema validator. See kernel/nodejs/src/application-env.ts.
        variables: {
          type: "object",
          additionalProperties: {
            type: "object",
            required: ["env", "type"],
            properties: {
              env: { type: "string" },
              type: {
                type: "string",
                enum: ["string", "integer", "number", "boolean", "object", "array"],
              },
              default: {},
            },
          },
        },
        secrets: {
          type: "object",
          additionalProperties: {
            type: "object",
            required: ["env", "type"],
            properties: {
              env: { type: "string" },
              type: {
                type: "string",
                enum: ["string", "integer", "number", "boolean", "object", "array"],
              },
              default: {},
            },
          },
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
