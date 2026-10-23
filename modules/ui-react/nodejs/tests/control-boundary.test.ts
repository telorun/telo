import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAllDocuments } from "yaml";
import { DESIGN_TOKENS } from "@telorun/ui";
import controls from "../src/contract/controls.json" with { type: "json" };
import contract from "../src/contract/parts.json" with { type: "json" };
import { CONTROL_MECHANICS } from "../src/browser/controls/mechanics.js";
import { tokenProperty } from "../src/contract/token-property.js";

/** A directory's TypeScript sources, as `/`-separated relative paths on every platform. */
const tsSources = (directory: URL) =>
  (readdirSync(directory, { recursive: true }) as string[]).map((file) => file.replaceAll("\\", "/")).filter((file) => /\.tsx?$/.test(file));

const browser = new URL("../src/browser/", import.meta.url);
const sources = tsSources(browser);
const read = (file: string) => readFileSync(new URL(file, browser), "utf8");
const inControls = (file: string) => file.startsWith("controls/");
const source = new URL("../src/", import.meta.url);
const allSources = tsSources(source);

describe("the renderer", () => {
  it("carries no primitive library: nothing imports Radix, and the package declares none", () => {
    const offenders = allSources.filter((file) => /from\s*"(radix-ui|@radix-ui\/[^"]+)"/.test(readFileSync(new URL(file, source), "utf8")));
    expect(offenders).toEqual([]);
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, Record<string, string> | undefined>;
    const declared = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((field) => Object.keys(manifest[field] ?? {}));
    expect(declared.filter((name) => name === "radix-ui" || name.startsWith("@radix-ui/"))).toEqual([]);
  });
});

describe("the built-in controls directory", () => {
  it("alone reaches the placement library and the icons, and draws the browser's entry elements", () => {
    const offenders: string[] = [];
    for (const file of sources.filter((each) => !inControls(each))) {
      const text = read(file);
      if (/from\s*"@floating-ui\/[^"]+"/.test(text)) offenders.push(`${file} imports @floating-ui`);
      if (/from\s*"lucide-react"/.test(text)) offenders.push(`${file} imports lucide-react`);
      if (/<(input|textarea)\b/.test(text)) offenders.push(`${file} draws an entry element`);
    }
    expect(offenders).toEqual([]);
  });

  it("draws no native list, dialog or popover, and nothing in the top layer", () => {
    const offenders = sources
      .filter(inControls)
      .flatMap((file) => {
        const text = read(file);
        return [
          /<(select|dialog)\b/.test(text) && `${file} draws a native <select> or <dialog>`,
          /\b(showModal|showPopover)\b/.test(text) && `${file} opens the top layer`,
          /\bpopover[=:]|setAttribute\(\s*"popover"/.test(text) && `${file} sets a popover attribute`,
        ].filter((found): found is string => typeof found === "string");
      });
    expect(offenders).toEqual([]);
  });

  it("reaches neither the host module nor the network", () => {
    const offenders = sources
      .filter(inControls)
      .filter((file) => /from\s*"@telorun\/ui-react"|\bfetch\(/.test(read(file)));
    expect(offenders).toEqual([]);
  });
});

/** Rules of a stylesheet holding one layer: each selector list with its declared properties. */
function rules(css: string, layer: string): { selector: string; properties: string[] }[] {
  const bare = css.replace(/\/\*[^]*?\*\//g, "");
  const opening = `@layer ${layer} {`;
  expect(bare.trim().startsWith(opening) && bare.trim().endsWith("}")).toBe(true);
  const body = bare.trim().slice(opening.length, -1);
  return [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, block]) => ({
    selector: selector.trim(),
    properties: block.split(";").map((declaration) => declaration.split(":")[0].trim()).filter(Boolean),
  }));
}

const named = (selector: string) => [...selector.matchAll(/\[data-telo-part="([^"]+)"\]/g)].map((match) => match[1]);

/** Parts only a control draws: the renderer draws a field's label and an in-flow surface itself. */
const controlOnly = new Set(
  Object.values(controls.controls)
    .flatMap((control) => [...control.roots, ...control.subParts, ...Object.values((control as { namedParts?: Record<string, string[]> }).namedParts ?? {}).flat()])
    .filter((part) => part !== "label" && part !== "surface"),
);

describe("the base layer", () => {
  const base = rules(readFileSync(new URL("../src/browser/base.css", import.meta.url), "utf8"), "telo.base");

  it("names no part only a control draws, and no primitive's variable", () => {
    expect(base.flatMap((rule) => named(rule.selector)).filter((part) => controlOnly.has(part))).toEqual([]);
    expect(readFileSync(new URL("../src/browser/base.css", import.meta.url), "utf8")).not.toContain("--radix-");
  });

  it("declares every reserved property on its part, so the documented layout holds under an empty theme", () => {
    const missing = contract.reserved.flatMap(({ part, properties }) =>
      properties.filter((property) => !base.some((rule) => named(rule.selector).includes(part) && rule.properties.includes(property))).map((property) => `${part} ${property}`),
    );
    expect(missing).toEqual([]);
  });
});

describe("a built-in control's mechanics", () => {
  it("is one stylesheet in the control layer, for a control of the set, reading no primitive's variable", () => {
    for (const [control, css] of Object.entries(CONTROL_MECHANICS)) {
      expect(Object.keys(controls.controls)).toContain(control);
      expect(rules(css as string, "telo.control").length).toBeGreaterThan(0);
      expect(css, control).not.toContain("--radix-");
    }
  });
});

// What the default theme styles, and that it sets no reserved property, is
// judged by `UiReactConformance.CheckTheme` in ../../tests/default-theme-conformance.yaml.
describe("the default theme", () => {
  it("reads no primitive's variable", () => {
    expect(readFileSync(new URL("../../themes/default/default-theme.css", import.meta.url), "utf8")).not.toContain("--radix-");
  });
});

describe("the --telo- custom properties", () => {
  it("are the design tokens' alone, in the base layer, every built-in's mechanics and the default theme", () => {
    const tokens = new Set(DESIGN_TOKENS.map(tokenProperty));
    const sheets: [string, string][] = [
      ["base.css", readFileSync(new URL("../src/browser/base.css", import.meta.url), "utf8")],
      ...Object.entries(CONTROL_MECHANICS).map(([control, css]) => [`${control} mechanics`, css as string] as [string, string]),
      ["default-theme.css", readFileSync(new URL("../../themes/default/default-theme.css", import.meta.url), "utf8")],
    ];
    const strays = sheets.flatMap(([sheet, css]) =>
      [...new Set([...css.matchAll(/--telo-[\w-]+/g)].map(([property]) => property))].filter((property) => !tokens.has(property)).map((property) => `${sheet}: ${property}`),
    );
    expect(strays).toEqual([]);
  });

  it("the base layer reads are exactly the tokens the contract says the renderer reads", () => {
    const base = readFileSync(new URL("../src/browser/base.css", import.meta.url), "utf8");
    const read = new Set([...base.matchAll(/var\((--telo-[\w-]+)/g)].map(([, property]) => property));
    expect([...read].sort()).toEqual(contract.rendererTokens.map(tokenProperty).sort());
  });
});

describe("the Controls kind", () => {
  const documents = parseAllDocuments(readFileSync(new URL("../../telo.yaml", import.meta.url), "utf8"), { logLevel: "silent" }).map((doc) => doc.toJS());
  const kind = documents.find((doc) => doc?.kind === "Telo.Definition" && doc.metadata?.name === "Controls");

  it("implements exactly the contract's controls", () => {
    expect(kind.schema.properties.implements.items.enum).toEqual(Object.keys(controls.controls));
  });

  it("holds as one unit exactly the controls the contract marks as layer controls", () => {
    const rule = kind.schema["x-telo-resource-rules"].find((each: { code: string }) => each.code === "UI_CONTROLS_LAYERS_PARTIAL");
    const lists = [...String(rule.condition).matchAll(/\[([^\]]+)\]/g)].map(([, list]) => [...list.matchAll(/'(\w+)'/g)].map(([, name]) => name));
    const marked = Object.entries(controls.controls as Record<string, { layer?: true }>).filter(([, control]) => control.layer === true).map(([name]) => name);
    expect(lists.length).toBe(2);
    for (const list of lists) expect(list).toEqual(marked);
  });
});
