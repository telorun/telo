import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

const docs: Record<string, any>[] = parseAllDocuments(readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8"), {
  logLevel: "silent",
}).map((doc) => doc.toJS());
const named = (name: string) => docs.find((doc) => doc.metadata?.name === name);

describe("the Relations shape", () => {
  it("is the shape a presentation's relations are written in", () => {
    const { title, description, ...relations } = named("CollectionPresentation")!.schema.properties.relations;
    expect(relations).toEqual(named("Relations")!.schema);
  });
});
