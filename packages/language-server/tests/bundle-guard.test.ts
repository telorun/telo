import { readFileSync } from "node:fs";
import { expect, it, inject } from "vitest";
// @ts-expect-error — a plain ESM build script with no declarations.
import { bundleEscapes } from "../scripts/bundle-guard.mjs";

// The guard reads the bundle as a program, so an escape is found wherever it
// is written, while a string that merely looks like one (AJV's code-generation
// templates carry `require("ajv/dist/runtime/equal")`) is not.
it("finds every escape from a bundle and none in the engine's", () => {
  const escapes = bundleEscapes(
    [
      `import fs from "node:fs";`,
      `export * from "./other.js";`,
      `const lazy = () => import("./lazy.js");`,
      `const path = require("path");`,
      `const id = process.getBuiltinModule("node:crypto");`,
      `const template = 'require("ajv/dist/runtime/equal")';`,
      `const o = { require: 1 }; o.require;`,
    ].join("\n"),
  );
  expect(escapes.map((e: string) => e.replace(/^\d+:\d+\s+/, ""))).toEqual([
    "static import of 'node:fs'",
    "Node built-in specifier 'node:fs'",
    "re-export from './other.js'",
    "dynamic import()",
    "reference to `require`",
    "Node built-in specifier 'node:crypto'",
  ]);
  expect(bundleEscapes(readFileSync(inject("engineBundle"), "utf8"))).toEqual([]);
});
