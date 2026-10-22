import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { DESIGN_TOKENS } from "../src/index.js";

describe("the exported design token names", () => {
  it("are exactly the properties Ui.DesignTokens declares", () => {
    const documents = parseAllDocuments(readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8"), { logLevel: "silent" }).map((doc) => doc.toJS());
    const kind = documents.find((doc) => doc?.kind === "Telo.Definition" && doc.metadata?.name === "DesignTokens");
    expect([...DESIGN_TOKENS].sort()).toEqual(Object.keys(kind.schema.properties).sort());
  });
});
