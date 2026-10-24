import { readdirSync, readFileSync } from "node:fs";
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

  it("word every keyword a server's validation issue may carry", () => {
    const directory = new URL("../../../../sdk/issue-keywords/", import.meta.url);
    const keywords = readdirSync(directory)
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(readFileSync(new URL(file, directory), "utf8")) as { keyword: string; params: string[] });
    expect(keywords.length).toBeGreaterThan(0);
    const words = named("Words").schema.properties as Record<string, Schema>;
    expect(keywords.filter(({ keyword }) => !words[keyword]).map(({ keyword }) => keyword)).toEqual([]);
  });

  it("each declare the values they are formatted with", () => {
    for (const [id, property] of Object.entries(named("Words").schema.properties as Record<string, Schema>)) {
      expect(property["x-telo-text-values"], id).toBeTypeOf("object");
    }
  });
});
