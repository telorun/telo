import { describe, expect, it } from "vitest";
import { optionOf, withPick } from "./configuration-picker-model";

const DIALECT = { key: "variables.dialect", values: ["sqlite", "memory"], default: "sqlite" };
const TOKEN = { key: "secrets.token", values: [null, "present"], default: null };

describe("the configuration picker", () => {
  it("names an absent input as absent and every other value as itself", () => {
    expect(optionOf(null).label).toBe("absent");
    expect(optionOf("memory")).toEqual({ id: '"memory"', label: "memory" });
    expect(optionOf(true).label).toBe("true");
  });

  it("moves one dimension and keeps the rest of the assignment", () => {
    const selected = { "variables.dialect": "sqlite", "secrets.token": null };
    expect(withPick(selected, DIALECT, '"memory"')).toEqual({ "variables.dialect": "memory", "secrets.token": null });
    expect(withPick(selected, TOKEN, '"present"')).toEqual({ "variables.dialect": "sqlite", "secrets.token": "present" });
    expect(withPick(selected, TOKEN, "null")).toEqual(selected);
  });
});
