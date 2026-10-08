import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";

/**
 * An app-relative reference is `/` followed by anything other than `/` or `\`,
 * with no ASCII control character anywhere. One table, held against every
 * place a manifest writes one: this module's `basePath`, and the vocabulary's
 * and the renderer's sites, which this module's screens are placed through.
 */
const refused = ["//x", "/\\x", "/\t/x", "/a\u007fb", "x"];
const accepted = ["/x", "/", "/a//b"];

const MANIFESTS = ["../../telo.yaml", "../../../ui/telo.yaml", "../../../ui-react/telo.yaml"];
const SITES = ["href", "src", "path", "basePath"];

/** Every `pattern` a schema declares on a property named as a reference site. */
function sitePatterns(node: unknown, trail: string[] = []): { site: string; pattern: string }[] {
  if (Array.isArray(node)) return node.flatMap((item, index) => sitePatterns(item, [...trail, String(index)]));
  if (!node || typeof node !== "object") return [];
  return Object.entries(node).flatMap(([key, value]) => {
    const pattern = (value as { pattern?: unknown } | null)?.pattern;
    const here = SITES.includes(key) && typeof pattern === "string" ? [{ site: [...trail, key].join("/"), pattern }] : [];
    return [...here, ...sitePatterns(value, [...trail, key])];
  });
}

const sites = MANIFESTS.flatMap((manifest) =>
  parseAllDocuments(readFileSync(new URL(manifest, import.meta.url), "utf8"), { logLevel: "silent" }).flatMap((document) => {
    const doc = document.toJS() as { metadata?: { name?: string } } | null;
    return sitePatterns(doc).map(({ site, pattern }) => ({ site: `${manifest} ${doc?.metadata?.name}: ${site}`, pattern }));
  }),
);

describe("an app-relative reference", () => {
  it("is declared at the nine places a manifest writes one", () => {
    expect(sites.map(({ site }) => site.replace(/^.*\/telo\.yaml /, "").replace(/: .*\//, " "))).toEqual([
      "Ui basePath",
      "Node href",
      "Node src",
      "SpecNode href",
      "SpecNode src",
      "Table basePath",
      "Form basePath",
      "Action path",
      "App path",
    ]);
  });

  it.each(sites)("is held to the one rule at $site", ({ pattern }) => {
    const matches = (reference: string) => new RegExp(pattern, "u").test(reference);
    expect(refused.filter(matches)).toEqual([]);
    expect(accepted.filter((reference) => !matches(reference))).toEqual([]);
  });
});
