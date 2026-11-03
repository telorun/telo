import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

type Doc = Record<string, any>;

const manifest = (path: string): Doc[] =>
  parseAllDocuments(readFileSync(new URL(path, import.meta.url), "utf8"), { logLevel: "silent" }).map((doc) => doc.toJS());

const declared = Object.keys(manifest("../../telo.yaml").find((doc) => doc.kind === "Telo.KeyedTranslations").keys);

describe("ui's own texts", () => {
  it("declare every key the controllers draw", () => {
    const directory = new URL("../src/", import.meta.url);
    const drawn = readdirSync(directory)
      .filter((file) => file.endsWith(".ts"))
      .flatMap((file) => [...readFileSync(new URL(file, directory), "utf8").matchAll(/\buiText\("([^"]+)"\)/g)].map((match) => match[1]));
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.filter((key) => !declared.includes(key))).toEqual([]);
  });

  it("declare a key for every keyword a server's validation issue may carry", () => {
    const directory = new URL("../../../../sdk/issue-keywords/", import.meta.url);
    const keywords = readdirSync(directory)
      .filter((file) => file.endsWith(".json"))
      .map((file) => (JSON.parse(readFileSync(new URL(file, directory), "utf8")) as { keyword: string }).keyword);
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords.filter((keyword) => !declared.includes(keyword))).toEqual([]);
  });

  it("are translated whole in every language ui ships", () => {
    const included = (manifest("../../telo.yaml")[0].include as string[]).map((path) => manifest(`../../${path}`)[0]);
    expect(included).toHaveLength(14);
    for (const catalog of included) {
      expect(catalog.kind).toBe("Self.Translations");
      expect(Object.keys(catalog.messages), catalog.lang).toEqual(declared);
    }
  });
});
