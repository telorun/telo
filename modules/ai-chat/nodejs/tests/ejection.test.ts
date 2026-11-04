import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

type Doc = Record<string, any>;

/** The documents of a manifest, each tagged scalar kept as `{ "!<tag>": text }`. */
function documents(url: URL): Doc[] {
  const customTags = ["cel", "ref", "interpolate", "sql"].map((tag) => ({
    tag: `!${tag}`,
    resolve: (value: string) => ({ [`!${tag}`]: value }),
  }));
  return parseAllDocuments(readFileSync(url, "utf8"), { customTags }).map((doc) => doc.toJS() as Doc);
}

const moduleUrl = new URL("../../telo.yaml", import.meta.url);
const fixtureUrl = new URL("../../tests/__fixtures__/ejected-api/telo.yaml", import.meta.url);
const chat = documents(moduleUrl);
const library = chat[0];
const body: Doc[] = chat.find((doc) => doc.kind === "Telo.Definition" && doc.metadata?.name === "Api")!.resources;

/** The body as an importer writes it: the module's own kinds through its alias,
 *  and the endpoint the kind is configured with as a library resource input. */
function ejected(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ejected);
  if (!value || typeof value !== "object") return value;
  const record = value as Doc;
  if (record["!cel"] === "self.conversation" && Object.keys(record).length === 1) return { "!ref": "conversation" };
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      key === "kind" && typeof entry === "string" && entry.startsWith("Self.") ? `AiChat.${entry.slice(5)}` : ejected(entry),
    ]),
  );
}

/** Every `kind` the body declares, at any depth. */
function kinds(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((entry) => kinds(entry, found));
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "kind" && typeof entry === "string") found.push(entry);
      else kinds(entry, found);
    }
  }
  return found;
}

/** The kinds a module lets an importer name; undefined when it gates none. */
function exportedKinds(source: string): readonly string[] | undefined {
  return documents(new URL(`../../${source}/telo.yaml`, import.meta.url))[0].exports?.kinds;
}

describe("Chat.Api's body", () => {
  it("is the ejected fixture, written with public kinds", () => {
    expect(documents(fixtureUrl).slice(1)).toEqual(ejected(body));
  });

  it("declares only kinds an importer can name", () => {
    const hidden = kinds(body).filter((kind) => {
      const [prefix, name] = kind.split(".");
      if (prefix === "Telo") return false;
      if (prefix === "Self") return !library.exports.kinds.includes(name);
      const source = library.imports[prefix];
      if (typeof source !== "string") return true;
      const exported = exportedKinds(source);
      return exported !== undefined && !exported.includes(name);
    });
    expect(hidden).toEqual([]);
  });
});
