import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";
import { refuseReservedKindPrefix } from "../src/reserved-kind-prefix.js";

function kernelOver(files: Record<string, string>): Kernel {
  const memory = new MemorySource();
  for (const [name, text] of Object.entries(files)) memory.set(name, text);
  return new Kernel({ sources: [memory], env: {} });
}

const LIBRARY = (name: string) => `kind: Telo.Library
metadata:
  name: ${name}
  version: 1.0.0
`;

describe("ERR_KIND_PREFIX_RESERVED", () => {
  it("refuses an import reaching a library named Self, carrying the check's diagnostic", async () => {
    const kernel = kernelOver({
      lib: LIBRARY("Self"),
      app: `kind: Telo.Application
metadata:
  name: App
imports:
  Lib: memory://lib
`,
    });
    await expect(kernel.load("memory://app")).rejects.toMatchObject({
      code: "ERR_KIND_PREFIX_RESERVED",
      message: expect.stringContaining("is a Telo.Library named 'Self'"),
      diagnostics: [
        expect.objectContaining({
          code: "KIND_PREFIX_RESERVED",
          message: expect.stringContaining("Cannot use import 'Lib' → 'memory://lib'"),
        }),
      ],
    });
  });

  it("refuses an import aliased Telo", async () => {
    const kernel = kernelOver({
      lib: LIBRARY("Plain"),
      app: `kind: Telo.Application
metadata:
  name: App
imports:
  Telo: memory://lib
`,
    });
    await expect(kernel.load("memory://app")).rejects.toMatchObject({
      code: "ERR_KIND_PREFIX_RESERVED",
      message: expect.stringContaining("An import may not be aliased 'Telo'"),
    });
  });

  it("is the guard every site registering a kind prefix runs", () => {
    for (const name of ["Telo", "Self"]) {
      expect(() => refuseReservedKindPrefix(name, () => `no ${name}`)).toThrowError(
        expect.objectContaining({ code: "ERR_KIND_PREFIX_RESERVED", message: `no ${name}` }),
      );
    }
    expect(() => refuseReservedKindPrefix("Orders", () => "unreachable")).not.toThrow();
    expect(() => refuseReservedKindPrefix(undefined, () => "unreachable")).not.toThrow();
  });
});
