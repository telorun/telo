import { AnalysisRegistry } from "@telorun/analyzer";
import { describe, expect, it } from "vitest";
import type { ParsedManifest } from "../../model";
import { moduleDeclarationOptions } from "./module-declarations";
import { resolveRefCandidates } from "./ref-candidates";

const app = {
  kind: "Application",
  filePath: "/ws/app/telo.yaml",
  metadata: { name: "Shop" },
  imports: [],
  resources: [],
  targets: [],
  needs: {
    site: { kind: "Telo.PublicUrl", parameters: { port: "http" } },
    tenants: { kind: "Telo.PublicHostPattern", parameters: { port: "http" } },
  },
} as unknown as ParsedManifest;

describe("a module's own declarations as reference candidates", () => {
  it("offers the needs a slot of their kind takes, and nothing else", () => {
    const options = moduleDeclarationOptions(app);
    expect(options).toEqual([
      { kind: "Telo.PublicUrl", name: "site" },
      { kind: "Telo.PublicHostPattern", name: "tenants" },
    ]);
    const registry = new AnalysisRegistry();
    expect(resolveRefCandidates(["Telo.PublicUrl"], options, registry).map((o) => o.name)).toEqual([
      "site",
    ]);
  });

  it("offers a library's resource inputs", () => {
    const lib = {
      ...app,
      kind: "Library",
      needs: undefined,
      resourceInputs: { connection: { kind: "Sql.Connection" } },
    } as unknown as ParsedManifest;
    expect(moduleDeclarationOptions(lib)).toEqual([{ kind: "Sql.Connection", name: "connection" }]);
  });
});
