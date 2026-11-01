import { readdirSync, readFileSync, statSync } from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { defaultCustomTags } from "@telorun/templating";
import { formatManifestText, isManifestText } from "../src/manifest-format.js";

function format(text: string): string {
  const result = formatManifestText(text);
  if (!result.ok) throw new Error(result.error.message);
  return result.text;
}

describe("formatManifestText", () => {
  it("writes a scalar list on one line and keeps quoting", () => {
    const out = format(
      "kind: Telo.Library\nschema:\n  enum:\n    - as\n    - \"true\"\n    - \"null\"\n    - a, b\n    - 'x: y'\n",
    );
    expect(out).toContain('enum: [as, "true", "null", "a, b", \'x: y\']');
  });

  it("flows small scalar maps and single-key chains", () => {
    const out = format("kind: A.B\nschema:\n  not:\n    enum:\n      - a\n  m:\n    a: 1\n    b: 2\n");
    expect(out).toContain("not: { enum: [a] }");
    expect(out).toContain("m: { a: 1, b: 2 }");
  });

  it("keeps a four-entry map in block style", () => {
    const src = "kind: A.B\nm:\n  a: 1\n  b: 2\n  c: 3\n  d: 4\n";
    expect(format(src)).toBe(src);
  });

  it("keeps collections with tags, comments or multi-line strings in block style", () => {
    const tagged = "kind: A.B\nl:\n  - !cel \"x\"\n  - b\n";
    const commented = "kind: A.B\nl:\n  - a # note\n  - b\n";
    const multi = "kind: A.B\nl:\n  - |\n    a\n    b\n";
    expect(format(tagged)).toBe(tagged);
    expect(format(commented)).toBe(commented);
    expect(format(multi)).toBe(multi);
  });

  it("is idempotent", () => {
    const once = format("kind: A.B\nl:\n  - a\n  - b\nm:\n  x:\n    - 1\n");
    expect(format(once)).toBe(once);
  });

  it("reports a syntax error with its location", () => {
    const result = formatManifestText("kind: A.B\nl: [a\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.line).toBeGreaterThan(0);
  });

  it("recognises manifests by a dotted kind", () => {
    expect(isManifestText("kind: Telo.Application\n")).toBe(true);
    expect(isManifestText("kind: Deployment\n")).toBe(false);
    expect(isManifestText("name: x\n")).toBe(false);
  });
});

function collect(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (["node_modules", "dist", ".git", ".telo", "__fixtures__"].includes(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) collect(full, out);
    else if (/\.ya?ml$/.test(name)) out.push(full);
  }
}

describe("formatManifestText over the repository", () => {
  it("preserves parsed data and is idempotent", () => {
    const root = path.resolve(__dirname, "../../..");
    const files: string[] = [];
    collect(path.join(root, "modules"), files);
    collect(path.join(root, "examples"), files);
    const data = (text: string) =>
      JSON.stringify(
        parseAllDocuments(text, { customTags: defaultCustomTags() }).map((d) => d.toJS()),
      );
    let checked = 0;
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      if (!isManifestText(text)) continue;
      const result = formatManifestText(text);
      if (!result.ok) continue;
      checked++;
      expect(data(result.text), file).toBe(data(text));
      const again = formatManifestText(result.text);
      expect(again.ok && again.text, file).toBe(result.text);
    }
    expect(checked).toBeGreaterThan(50);
  });
});
