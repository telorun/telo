import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import abi from "../src/contract/abi.json" with { type: "json" };
import controls from "../src/contract/controls.json" with { type: "json" };
import parts from "../src/contract/parts.json" with { type: "json" };

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const rows = (page: string) => [...page.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);
const names = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
/** The text under a `##` heading, up to the next one. */
const section = (page: string, heading: string) => {
  const start = page.indexOf(`\n## ${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const end = page.indexOf("\n## ", start + 1);
  return page.slice(start, end === -1 ? undefined : end);
};
/** A table's rows, each split into its cells. */
const table = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| ---"))
    .slice(1)
    .map((line) => line.slice(2, -2).split(" | "));

describe("the documented styling contract", () => {
  const page = read("../../docs/styling.md");

  it("lists exactly the parts and states of the data file", () => {
    const documented = [...rows(section(page, "Parts")), ...rows(section(page, "State"))];
    const states = Object.keys(parts.states).map((attribute) => `${attribute}="…"`);
    expect(documented.sort()).toEqual([...Object.values(parts.parts).flat(), ...states, 'data-style="…"'].sort());
  });

  it("lists exactly the renderer's own part states of the data file", () => {
    const list = "((?:`[^`]+`(?:, )?)+)";
    const documented = [...section(page, "State").matchAll(new RegExp(`^\\| ${list} \\| ${list} \\|$`, "gm"))].map((match) => ({
      values: names(match[1]),
      on: names(match[2]),
    }));
    expect(documented).toEqual(parts.partStates);
  });

  it("lists exactly the reserved properties of the data file", () => {
    const documented = table(section(page, "Reserved properties")).map(([part, properties, because]) => ({ part: names(part)[0], properties: names(properties), because }));
    expect(documented).toEqual(parts.reserved);
  });
});

describe("the documented component ABI", () => {
  it("lists exactly the ABI's supplied specifiers and host fields, and embeds its declaration", () => {
    const page = read("../../docs/component-abi.md");
    expect(rows(page)).toEqual([...abi.specifiers, ...abi.hostFields]);
    expect(page).toContain("```ts\n" + read("../src/contract/ui-react.d.ts") + "```");
  });

  it("declares in the type file exactly the host fields", () => {
    const host = read("../src/contract/ui-react.d.ts").split("export interface Host {")[1].split("\n}")[0];
    const declared = [...host.matchAll(/^  (?:readonly )?([a-zA-Z]+)[(:]/gm)].map((match) => match[1]);
    expect(declared).toEqual(abi.hostFields);
  });
});

/** The members of each interface of the controls declaration, those it extends included. */
function declaredMembers(source: string): Map<string, string[]> {
  const own = new Map<string, { extends: string[]; members: string[] }>();
  for (const [, name, extended, body] of source.matchAll(/export interface (\w+)(?: extends ([\w, ]+))? \{\n([^]*?)\n\}/g)) {
    const members = [...body.matchAll(/^  (?:readonly )?([a-zA-Z]+)\??[(:]/gm)].map((match) => match[1]);
    own.set(name, { extends: extended ? extended.split(",").map((each) => each.trim()) : [], members });
  }
  const all = (name: string): string[] => {
    const entry = own.get(name);
    return entry ? [...entry.extends.flatMap(all), ...entry.members] : [];
  };
  return new Map([...own.keys()].map((name) => [name, all(name)]));
}

describe("the documented controls contract", () => {
  const page = read("../../docs/controls-abi.md");
  const declaration = read("../src/contract/ui-react-controls.d.ts");
  const entries = Object.entries(controls.controls);

  it("lists every control with its root and sub-parts", () => {
    const documented = table(section(page, "The control set")).map(([name, , roots, sub]) => ({ name: names(name)[0], roots: names(roots), sub: names(sub).sort() }));
    expect(documented).toEqual(
      entries.map(([name, control]) => ({
        name,
        roots: control.roots,
        sub: [...control.subParts, ...Object.values((control as { namedParts?: Record<string, string[]> }).namedParts ?? {}).flat()].sort(),
      })),
    );
  });

  it("lists every control's intents and states", () => {
    const intents = table(section(page, "Intents")).map(([name, cell]) => [names(name)[0], names(cell)]);
    expect(intents).toEqual(
      entries
        .filter(([, control]) => Object.keys(control.intents).length > 0)
        .map(([name, control]) => [name, Object.entries(control.intents as Record<string, string | null>).flatMap(([intent, sets]) => (sets ? [intent, sets] : [intent]))]),
    );
    const states = table(section(page, "States")).map(([name, attribute, values]) => [names(name)[0], names(attribute)[0], values === "present" ? [""] : names(values)]);
    expect(states).toEqual(entries.flatMap(([name, control]) => control.states.map((state) => [name, state.attribute, state.values])));
  });

  it("lists the glyph names and the supplied specifiers of the data file", () => {
    expect(names(section(page, "The control set").split("closed too:")[1].split("A glyph inside")[0])).toEqual(controls.icons);
    expect(rows(section(page, "What a module may leave to the page"))).toEqual(controls.supplied);
    const union = declaration.split("export type IconName =")[1].split(";")[0];
    expect([...union.matchAll(/"([^"]+)"/g)].map((match) => match[1])).toEqual(controls.icons);
  });

  it("embeds the declaration, which declares exactly each control's props", () => {
    expect(page).toContain("```ts\n" + declaration + "```");
    const members = declaredMembers(declaration);
    for (const [name, control] of entries) expect((members.get(`${name}Props`) ?? []).sort(), name).toEqual([...control.props].sort());
    const set = declaration.split("export interface Controls {")[1].split("\n}")[0];
    expect([...set.matchAll(/^  (\w+):/gm)].map((match) => match[1])).toEqual(entries.map(([name]) => name));
  });
});
