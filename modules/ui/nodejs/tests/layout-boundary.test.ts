import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

type Doc = Record<string, any>;

const read = (url: URL): Doc[] =>
  parseAllDocuments(readFileSync(url, "utf8"), {
    logLevel: "silent",
    customTags: [{ tag: "!cel", resolve: (text: string) => text }, { tag: "!ref", resolve: (text: string) => text }],
  }).map((doc) => doc.toJS());

const docs = read(new URL("../../telo.yaml", import.meta.url));

/** Every kind the manifest names: a document's `kind` and `extends`, and each `x-telo-ref` kind at any depth. */
function namedKinds(): string[] {
  const kinds: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "x-telo-ref") kinds.push(...(typeof value === "string" ? [value] : [(value as Doc).kind].flat()));
      else visit(value);
    }
  };
  for (const doc of docs) {
    kinds.push(doc.kind, ...(typeof doc.extends === "string" ? [doc.extends] : []));
    visit(doc.schema);
  }
  return kinds.filter((kind): kind is string => typeof kind === "string");
}

describe("ui's layouts", () => {
  it("name no layout kind another module declares", () => {
    const imports = docs[0].imports as Record<string, string>;
    const foreign = new Set(namedKinds().map((kind) => kind.split(".")[0]).filter((alias) => alias !== "Self" && alias !== "Telo"));
    expect([...foreign].every((alias) => Object.hasOwn(imports, alias))).toBe(true);
    for (const alias of foreign) {
      const declared = read(new URL(`../../${imports[alias]}/telo.yaml`, import.meta.url));
      expect(declared.filter((doc) => typeof doc.extends === "string" && doc.extends.endsWith(".ListingLayout")), alias).toEqual([]);
    }
    const layouts = docs.filter((doc) => doc.extends === "Self.ListingLayout").map((doc) => doc.metadata.name);
    expect(layouts.sort()).toEqual(["BoardLayout", "CalendarLayout", "CardLayout", "ComponentLayout", "ListLayout", "TableLayout", "TimelineLayout", "TreeLayout"]);
  });
});
