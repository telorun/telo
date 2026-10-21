import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

type Schema = Record<string, any>;

const docs: Schema[] = parseAllDocuments(readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8"), { logLevel: "silent" }).map(
  (doc) => doc.toJS(),
);
const named = (name: string): Schema => {
  const found = docs.find((doc) => doc.metadata?.name === name);
  if (!found) throw new Error(`the manifest declares no '${name}'`);
  return found;
};

describe("the renderer's own words", () => {
  it("are one set: every id the wire names, every word Ui.Words declares and every word ui writes", () => {
    const wire = [...named("SpecNode").schema.$defs.Word.properties.word.enum].sort();
    const kind = named("Words").schema;
    const written = Object.keys(named("words")).filter((key) => key !== "kind" && key !== "metadata");
    expect(Object.keys(kind.properties).sort()).toEqual(wire);
    expect([...kind.required].sort()).toEqual(wire);
    expect(written.sort()).toEqual(wire);
  });

  it("each declare the values they are formatted with", () => {
    for (const [id, property] of Object.entries(named("Words").schema.properties as Record<string, Schema>)) {
      expect(property["x-telo-text-values"], id).toBeTypeOf("object");
    }
  });
});
