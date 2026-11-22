import { describe, expect, it } from "vitest";
import { assignConcretePath } from "../src/manifest-path.js";
import { setOwnProperty } from "../src/own-property.js";

describe("writing a manifest key", () => {
  it("keeps a __proto__ key as an own data property and leaves Object.prototype alone", () => {
    const target: Record<string, unknown> = {};
    setOwnProperty(target, "__proto__", { polluted: true });
    expect(Object.getOwnPropertyDescriptor(target, "__proto__")?.value).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("assigns a concrete path whose last key is __proto__ as data", () => {
    const root: Record<string, any> = { a: {} };
    assignConcretePath(root, "a.__proto__", { polluted: true });
    expect(Object.keys(root.a)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(root.a)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
