import type { ResourceManifest } from "@telorun/sdk";
import { describe, expect, it } from "vitest";
import { scopeAddress } from "../src/scope-address.js";
import { MANIFEST_READING, ScopedNameResolver } from "../src/scoped-name-resolver.js";

const declaration = (name: string, module?: string): ResourceManifest =>
  ({ kind: "Test.Thing", metadata: { name, ...(module ? { module } : {}) } }) as ResourceManifest;

describe("scopeAddress", () => {
  it("tells a member from a module-level declaration of the same name, and from a member of another scope", () => {
    const sequence = scopeAddress("app", "sequence");
    const member = scopeAddress({ holder: sequence, field: "with" }, "db");
    expect(member.key).toBe(scopeAddress({ holder: scopeAddress("app", "sequence"), field: "with" }, "db").key);
    expect(member.module).toBe("app");
    expect(member.key).not.toBe(scopeAddress("app", "db").key);
    expect(member.key).not.toBe(scopeAddress({ holder: scopeAddress("app", "other"), field: "with" }, "db").key);
  });
});

describe("ScopedNameResolver", () => {
  const outerDb = declaration("db", "app");
  const sequence = scopeAddress("app", "sequence");
  const sequenceScope = { holder: sequence, field: "with" };
  const scopedDb = declaration("db", "app");
  const cache = declaration("cache", "app");

  const resolver = () => {
    const names = new ScopedNameResolver([outerDb, declaration("sequence", "app")], MANIFEST_READING);
    names.declareScope(sequenceScope, [scopedDb, cache]);
    return names;
  };

  it("reads a name at module level with no scope, where no scope member is in reach", () => {
    const names = resolver();
    expect(names.resolve("db", "app")).toBe(outerDb);
    expect(names.resolve("cache", "app")).toBeUndefined();
  });

  it("lets a scope member shadow the module-level declaration of its name inside its scope", () => {
    const found = resolver().locate("db", "app", sequenceScope);
    expect(found?.declaration).toBe(scopedDb);
    expect(found?.address.key).toBe(scopeAddress(sequenceScope, "db").key);
  });

  it("reads through nested scopes innermost out, then the module", () => {
    const names = resolver();
    const inner = { holder: scopeAddress(sequenceScope, "nested"), field: "with" };
    const innerCache = declaration("cache", "app");
    names.declareScope(inner, [innerCache]);
    expect(names.resolve("cache", "app", inner)).toBe(innerCache);
    expect(names.resolve("db", "app", inner)).toBe(scopedDb);
    expect(names.resolve("sequence", "app", inner)).toBe(names.resolve("sequence", "app"));
  });

  it("resolves a shadowed name the reader cannot take to nothing, never to what it shadows", () => {
    const names = resolver();
    expect(names.resolve("db", "app", sequenceScope, (d) => d !== scopedDb)).toBeUndefined();
  });
});
