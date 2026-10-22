import { describe, expect, it } from "vitest";
import { windowConsole } from "../src/conformance-window.js";

describe("the window's console", () => {
  it("hands over every line written to it, from every method, and none that is blank", () => {
    const lines: string[] = [];
    const console = windowConsole((line) => lines.push(line));
    console.log("rendered %s", "twice");
    console.error("first\n\nsecond");
    console.warn("");
    console.count("draws");
    expect(lines).toEqual(["rendered twice", "first", "second", "draws: 1"]);
  });
});
