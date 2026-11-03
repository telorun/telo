import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPTIONS } from "../src/browser/filters.js";
import { ISSUE_VALUES } from "../src/browser/problem-details.js";
import { UI_SET, uiKeys } from "./ui-texts.js";

const source = join(process.cwd(), "src");

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

const renderer = filesUnder(join(source, "browser")).map((path) => ({ path, text: readFileSync(path, "utf8") }));
const literals = (text: string): string[] => [...text.matchAll(/(?<![=!]==\s*)"([A-Za-z]+)"/g)].map((match) => match[1]);

/** Every key the renderer names: a literal it says (not one compared against),
 *  a validation keyword it fails with, an own text it builds, and the keys its
 *  caption maps hold. */
function drawnKeys(): string[] {
  const keys = new Set<string>([...Object.values(CAPTIONS), ...Object.keys(ISSUE_VALUES)]);
  for (const { text } of renderer) {
    for (const call of text.matchAll(/\bsay\(([^,)]*)/g)) for (const key of literals(call[1])) keys.add(key);
    for (const call of text.matchAll(/\bfail\("([A-Za-z]+)"/g)) keys.add(call[1]);
    for (const own of text.matchAll(/\bkey: "([A-Za-z]+)"/g)) keys.add(own[1]);
    const longer = /LONGER_THAN[^=]*=\s*\{([^}]*)\}/.exec(text);
    if (longer) for (const key of literals(longer[1])) keys.add(key);
  }
  return [...keys];
}

describe("the renderer's own texts", () => {
  it("are keys ui declares, every one", () => {
    const drawn = drawnKeys();
    expect(drawn.length).toBeGreaterThan(60);
    expect(drawn.filter((key) => !uiKeys.includes(key))).toEqual([]);
  });

  it("are drawn from the set the application document names, never from one the renderer or its controller names", () => {
    const controller = readdirSync(source)
      .filter((name) => /\.ts$/.test(name))
      .map((name) => ({ path: join(source, name), text: readFileSync(join(source, name), "utf8") }));
    expect([...renderer, ...controller].filter(({ text }) => text.includes(UI_SET)).map(({ path }) => path)).toEqual([]);
  });
});
