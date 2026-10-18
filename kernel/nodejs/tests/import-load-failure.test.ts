import type { ManifestSource } from "@telorun/analyzer";
import { RuntimeError } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

describe("an import the load refuses", () => {
  it("refuses the built-in vocabulary archive as ERR_INVALID_IMPORT_TARGET, carrying the check's diagnostic", async () => {
    const memory = new MemorySource();
    memory.set(
      "builtins",
      `kind: Telo.Builtins
metadata:
  name: Telo
  version: 0.119.0
  license: MIT
---
kind: Telo.Abstract
metadata:
  name: Service
capability: Telo.Service
declarable: true
`,
    );
    memory.set(
      "app",
      `kind: Telo.Application
metadata:
  name: App
imports:
  Builtins: memory://builtins
`,
    );
    const sentence =
      "'memory://builtins' is the built-in vocabulary of telo 0.119.0; its kinds need no import — " +
      "remove this `imports:` entry and write them as `Telo.<Kind>`.";
    await expect(new Kernel({ sources: [memory], env: {} }).load("memory://app")).rejects.toMatchObject({
      code: "ERR_INVALID_IMPORT_TARGET",
      message: sentence,
      diagnostics: [
        expect.objectContaining({
          code: "INVALID_IMPORT_TARGET",
          message: `Cannot use import 'Builtins' → 'memory://builtins': ${sentence}`,
          origin: expect.objectContaining({ path: "imports.Builtins" }),
        }),
      ],
    });
  });

  it("keeps the code a loader's own refusal carries", async () => {
    const refusing: ManifestSource = {
      supports: (url) => url.startsWith("https://refused.example/"),
      read: async () => {
        throw new RuntimeError("ERR_EGRESS_DENIED", "egress to refused.example is denied");
      },
      resolveRelative: (base, relative) => relative,
    };
    const memory = new MemorySource();
    memory.set(
      "app",
      `kind: Telo.Application
metadata:
  name: App
imports:
  Lib: https://refused.example/lib
`,
    );
    await expect(
      new Kernel({ sources: [memory, refusing], env: {} }).load("memory://app"),
    ).rejects.toMatchObject({
      code: "ERR_EGRESS_DENIED",
      diagnostics: [expect.objectContaining({ code: "IMPORT_UNRESOLVED" })],
    });
  });
});
