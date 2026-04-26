import { describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

describe("MemorySource", () => {
  describe("set + read", () => {
    it("stores a bare module name under <name>/telo.yaml and reads back via memory://<name>", async () => {
      const memory = new MemorySource();
      memory.set("app", "kind: Telo.Application\nmetadata:\n  name: A\n  version: 1.0.0\n");

      const result = await memory.read("memory://app");

      expect(result.source).toBe("memory://app/telo.yaml");
      expect(result.text).toContain("kind: Telo.Application");
    });

    it("reads back via the canonical /telo.yaml URL too", async () => {
      const memory = new MemorySource();
      memory.set("app", "kind: Telo.Application\nmetadata:\n  name: A\n  version: 1.0.0\n");

      const result = await memory.read("memory://app/telo.yaml");

      expect(result.source).toBe("memory://app/telo.yaml");
    });

    it("stores partial files literally when the name has a .yaml extension", async () => {
      const memory = new MemorySource();
      memory.set("app/sub.yaml", "kind: Some.Thing\nmetadata:\n  name: S\n");

      const result = await memory.read("memory://app/sub.yaml");

      expect(result.source).toBe("memory://app/sub.yaml");
      expect(result.text).toContain("kind: Some.Thing");
    });

    it("serializes parsed-manifest object arrays through yaml.stringify", async () => {
      const memory = new MemorySource();
      memory.set("app", [
        { kind: "Telo.Application", metadata: { name: "A", version: "1.0.0" } },
      ]);

      const { text } = await memory.read("memory://app");

      expect(text).toContain("kind: Telo.Application");
      expect(text).toContain("name: A");
    });

    it("throws on unknown URL with both keys mentioned", async () => {
      const memory = new MemorySource();

      await expect(memory.read("memory://missing")).rejects.toThrow(/missing.*missing\/telo\.yaml/);
    });

    it("rejects names with leading slash", () => {
      const memory = new MemorySource();
      expect(() => memory.set("/abs", "")).toThrow(/absolute root/);
    });

    it("rejects names with .. segments", () => {
      const memory = new MemorySource();
      expect(() => memory.set("../escape", "")).toThrow(/escape/);
    });

    it("rejects names that look like URLs", () => {
      const memory = new MemorySource();
      expect(() => memory.set("memory://x", "")).toThrow(/scheme/);
    });
  });

  describe("resolveRelative", () => {
    const memory = new MemorySource();

    it("resolves sibling include paths", () => {
      expect(memory.resolveRelative("memory://app/telo.yaml", "./sub.yaml")).toBe(
        "memory://app/sub.yaml",
      );
    });

    it("resolves sibling module via .. step", () => {
      expect(memory.resolveRelative("memory://app/telo.yaml", "../shared")).toBe(
        "memory://shared",
      );
    });

    it("resolves nested-module relative paths", () => {
      expect(memory.resolveRelative("memory://auth/login/telo.yaml", "../register")).toBe(
        "memory://auth/register",
      );
    });

    it("throws on paths that escape the namespace root", () => {
      expect(() => memory.resolveRelative("memory://app/telo.yaml", "../../foo")).toThrow(
        /escapes/,
      );
    });

    it("throws on absolute-slash relatives", () => {
      expect(() => memory.resolveRelative("memory://app/telo.yaml", "/foo")).toThrow(
        /absolute root/,
      );
    });

    it("throws on already-absolute URLs as relative", () => {
      expect(() =>
        memory.resolveRelative("memory://app/telo.yaml", "file:///etc/x"),
      ).toThrow(/absolute URL/);
    });
  });
});

describe("Kernel boots from memory:// URL", () => {
  it("loads and starts an in-memory Telo.Application with no targets", async () => {
    const memory = new MemorySource();
    memory.set(
      "app",
      `kind: Telo.Application
metadata:
  name: InMemoryApp
  version: 1.0.0
`,
    );

    const kernel = new Kernel({ sources: [memory], env: {} });
    await kernel.load("memory://app");
    await kernel.start();

    expect(kernel.exitCode).toBe(0);
  });

  it("resolves a memory:// Telo.Import from an in-memory Application", async () => {
    const memory = new MemorySource();
    memory.set(
      "lib",
      `kind: Telo.Library
metadata:
  name: my-lib
  version: 1.0.0
`,
    );
    memory.set(
      "app",
      `kind: Telo.Application
metadata:
  name: InMemoryApp
  version: 1.0.0
---
kind: Telo.Import
metadata:
  name: MyLib
source: memory://lib
`,
    );

    const kernel = new Kernel({ sources: [memory], env: {} });
    await kernel.load("memory://app");
    await kernel.start();

    expect(kernel.exitCode).toBe(0);
  });
});
