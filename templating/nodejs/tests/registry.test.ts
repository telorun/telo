import { describe, expect, it } from "vitest";
import {
  builtinEngines,
  createDefaultRegistry,
  defaultRegistry,
} from "../src/builtins.js";
import type { TemplatingEngine } from "../src/engine.js";
import { TemplatingEngineRegistry } from "../src/registry.js";

const noopEngine: TemplatingEngine = {
  name: "noop",
  compile: (s) => s,
  analyze: () => [],
};

describe("TemplatingEngineRegistry", () => {
  it("registers and retrieves engines by name", () => {
    const r = new TemplatingEngineRegistry();
    r.register(noopEngine);
    expect(r.get("noop")).toBe(noopEngine);
    expect(r.has("noop")).toBe(true);
  });

  it("returns undefined for unknown engine names", () => {
    const r = new TemplatingEngineRegistry();
    expect(r.get("missing")).toBeUndefined();
    expect(r.has("missing")).toBe(false);
  });

  it("rejects duplicate registrations to surface integration mistakes", () => {
    const r = new TemplatingEngineRegistry();
    r.register(noopEngine);
    expect(() => r.register(noopEngine)).toThrow(/already registered/);
  });

  it("list() returns engines in registration order", () => {
    const r = new TemplatingEngineRegistry();
    const a: TemplatingEngine = { name: "a", compile: (s) => s, analyze: () => [] };
    const b: TemplatingEngine = { name: "b", compile: (s) => s, analyze: () => [] };
    r.register(a);
    r.register(b);
    expect(r.list().map((e) => e.name)).toEqual(["a", "b"]);
  });
});

describe("builtinEngines + createDefaultRegistry", () => {
  it("ships cel, literal and ref as built-ins", () => {
    expect(builtinEngines.map((e) => e.name).sort()).toEqual(["cel", "literal", "ref"]);
  });

  it("createDefaultRegistry registers every builtin", () => {
    const r = createDefaultRegistry();
    for (const e of builtinEngines) {
      expect(r.has(e.name)).toBe(true);
    }
  });

  it("createDefaultRegistry returns a fresh instance each call", () => {
    expect(createDefaultRegistry()).not.toBe(createDefaultRegistry());
  });
});

describe("defaultRegistry", () => {
  it("returns the same memoized instance on repeat calls", () => {
    expect(defaultRegistry()).toBe(defaultRegistry());
  });

  it("contains every built-in engine", () => {
    const r = defaultRegistry();
    for (const e of builtinEngines) {
      expect(r.has(e.name)).toBe(true);
    }
  });
});
