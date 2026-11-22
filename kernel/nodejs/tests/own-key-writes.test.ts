import { describe, expect, it } from "vitest";
import { compileRedactionPolicy, redactAttributes } from "../src/logging/redact-attributes.js";
import { recordControllerCopy, syncInjectedReferences } from "../src/text-records.js";

describe("a __proto__ key is data", () => {
  it("is censored in place by a redaction path, leaving Object.prototype untouched", () => {
    const attributes = JSON.parse('{"__proto__": "secret", "keep": 1}');
    redactAttributes(attributes, compileRedactionPolicy({ paths: ["__proto__"] }));
    expect(Object.getOwnPropertyDescriptor(attributes, "__proto__")?.value).toBe("[redacted]");
    expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
    expect(attributes.keep).toBe(1);
  });

  it("is carried into a controller's copy as an own property", () => {
    const declaration = JSON.parse('{"__proto__": {"polluted": true}}');
    const copy: Record<string, unknown> = {};
    recordControllerCopy(declaration, copy, []);
    syncInjectedReferences(declaration);
    expect(Object.keys(copy)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("is not descended into through the copy's prototype when a text path runs beneath it", () => {
    const declaration = JSON.parse('{"__proto__": {"polluted": true}}');
    const copy: Record<string, unknown> = {};
    recordControllerCopy(declaration, copy, [["__proto__", "label"]]);
    syncInjectedReferences(declaration);
    expect(Object.getOwnPropertyDescriptor(copy, "__proto__")?.value).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
