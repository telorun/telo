import { describe, expect, it } from "vitest";
import { jsonPointer } from "./field-pointer";

describe("field path → JSON Pointer", () => {
  it("converts an indexed path", () => {
    expect(jsonPointer("steps[0]")).toBe("/steps/0");
    expect(jsonPointer("routes[2]")).toBe("/routes/2");
  });

  it("converts a nested branch path", () => {
    expect(jsonPointer("steps[1].then[0]")).toBe("/steps/1/then/0");
    expect(jsonPointer("steps[0].cases.ok[2]")).toBe("/steps/0/cases/ok/2");
  });

  it("converts a plain field", () => {
    expect(jsonPointer("targets[0]")).toBe("/targets/0");
    expect(jsonPointer("steps[0].inputs")).toBe("/steps/0/inputs");
  });

  it("escapes a map key that would otherwise re-read as pointer syntax", () => {
    expect(jsonPointer("content.application/json")).toBe("/content/application~1json");
  });
});
