import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import abi from "../src/contract/abi.json" with { type: "json" };
import parts from "../src/contract/parts.json" with { type: "json" };

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const rows = (page: string) => [...page.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]);

describe("the documented contract", () => {
  it("lists exactly the parts and states of the data file", () => {
    const documented = rows(read("../../docs/styling.md"));
    const states = Object.keys(parts.states).map((attribute) => `${attribute}="…"`);
    expect(documented.sort()).toEqual([...Object.values(parts.parts).flat(), ...states, 'data-style="…"'].sort());
  });

  it("lists exactly the primitives' states of the data file", () => {
    const names = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const list = "((?:`[^`]+`(?:, )?)+)";
    const documented = [...read("../../docs/styling.md").matchAll(new RegExp(`^\\| ${list} \\| ${list} \\|$`, "gm"))].map((match) => ({
      values: names(match[1]),
      on: names(match[2]),
    }));
    expect(documented).toEqual(parts.primitiveStates);
  });

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
