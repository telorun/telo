import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";
import type { CelProgram } from "@telorun/cel";
import type { CompiledValue } from "@telorun/sdk";
import {
  buildCelEnvironment,
  compileExpression,
  type CelProgramSite,
} from "@telorun/templating";
import { CelEmittedModules } from "../src/cel-emitted-modules.js";
import { Kernel } from "../src/kernel.js";
import { MemorySource } from "../src/manifest-sources/memory-source.js";

/**
 * Load-time CEL runs on the program emitted into `<cache-root>/cel/`, not on the closure the
 * loader compiled. What is pinned: the module is written and every site is switched onto it;
 * a second load reads the stored module rather than writing it again; a read-only cache that
 * does not hold the module leaves the closures in place and writes nothing; and the switched
 * program answers what the closure answered.
 */

const SOURCES = ["1 + 2", "variables.name + '!'", "[1, 2, 3].map(x, x * 2)"];

interface Recorded {
  readonly compiled: CompiledValue[];
  readonly sites: CelProgramSite[];
  readonly used: CelProgram[];
}

function compileFile(sources: readonly string[] = SOURCES): Recorded {
  const environment = buildCelEnvironment();
  const collected: CelProgramSite[] = [];
  const compiled = sources.map((source) =>
    compileExpression(source, environment, undefined, collected),
  );
  const used: CelProgram[] = [];
  const sites = collected.map((site) => ({
    source: site.source,
    environment: site.environment,
    use: (program: CelProgram) => {
      used.push(program);
      site.use(program);
    },
  }));
  return { compiled, sites, used };
}

function moduleOf(sites: readonly CelProgramSite[]) {
  return { owner: { celProgramSites: sites }, partials: [] } as never;
}

/** A fresh directory by its real path: on Windows `os.tmpdir()` is an 8.3 short path whose
 *  `~` the test runner's module loader does not resolve when the module is imported. */
function tempDir(): string {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), "telo-cel-")));
}

const warnings: string[] = [];
const log = { warn: (message: string) => warnings.push(message) } as never;

function storedModules(root: string): string[] {
  return readdirSync(path.join(root, "cel")).filter((name) => name.endsWith(".mjs"));
}

function evaluateAll(compiled: readonly CompiledValue[]): unknown[] {
  return compiled.map((value) => value.call!({ variables: { name: "telo" } }));
}

describe("emitted CEL modules", () => {
  it("writes one module per file and environment and switches every site onto it", async () => {
    const root = tempDir();
    const file = compileFile();
    const before = evaluateAll(file.compiled);

    await new CelEmittedModules(root, { write: true, log }).adopt(moduleOf(file.sites));

    expect(readdirSync(path.join(root, "cel")).filter((name) => name.endsWith(".mjs"))).toHaveLength(1);
    expect(file.used).toHaveLength(SOURCES.length);
    expect(evaluateAll(file.compiled)).toEqual(before);
  });

  it("reads the stored module on a later load instead of writing it again", async () => {
    const root = tempDir();
    await new CelEmittedModules(root, { write: true, log }).adopt(moduleOf(compileFile().sites));
    const [stored] = readdirSync(path.join(root, "cel"));
    const written = statSync(path.join(root, "cel", stored!)).mtimeMs;

    const again = compileFile();
    await new CelEmittedModules(root, { write: true, log }).adopt(moduleOf(again.sites));

    expect(statSync(path.join(root, "cel", stored!)).mtimeMs).toBe(written);
    expect(again.used).toHaveLength(SOURCES.length);
  });

  it("keeps the closures when a read-only cache does not hold the module", async () => {
    const root = tempDir();
    const file = compileFile();

    await new CelEmittedModules(root, { write: false, log }).adopt(moduleOf(file.sites));

    expect(file.used).toHaveLength(0);
    expect(() => readdirSync(path.join(root, "cel"))).toThrow();
  });

  it("serves a stored module from a read-only cache", async () => {
    const root = tempDir();
    await new CelEmittedModules(root, { write: true, log }).adopt(moduleOf(compileFile().sites));

    const file = compileFile();
    await new CelEmittedModules(root, { write: false, log }).adopt(moduleOf(file.sites));

    expect(file.used).toHaveLength(SOURCES.length);
  });

  it("emits a stored module again when its text was edited", async () => {
    const root = tempDir();
    await new CelEmittedModules(root, { write: true, log }).adopt(moduleOf(compileFile().sites));
    const stored = path.join(root, "cel", storedModules(root)[0]!);
    const original = readFileSync(stored, "utf8");
    appendFileSync(stored, "// edited\n");

    const file = compileFile();
    await new CelEmittedModules(root, { write: true, log }).adopt(moduleOf(file.sites));

    expect(readFileSync(stored, "utf8")).toBe(original);
    expect(file.used).toHaveLength(SOURCES.length);
  });

  it("reports a cache that cannot be written once and keeps the closures", async () => {
    // A cache root that is a file: the module directory beneath it cannot be made.
    const root = path.join(tempDir(), "root");
    writeFileSync(root, "");
    const reported = warnings.length;
    const modules = new CelEmittedModules(root, { write: true, log });
    const first = compileFile(["1 + 1"]);
    const second = compileFile(["2 + 2"]);

    await modules.adopt(moduleOf(first.sites));
    await modules.adopt(moduleOf(second.sites));

    expect(warnings.length - reported).toBe(1);
    expect([...first.used, ...second.used]).toHaveLength(0);
  });

  it("keeps the closures with no cache root", async () => {
    const file = compileFile();
    await new CelEmittedModules(undefined, { write: true, log }).adopt(moduleOf(file.sites));
    expect(file.used).toHaveLength(0);
  });
});

describe("emitted CEL modules at kernel load", () => {
  it("emits a module for the entry file and for every imported library", async () => {
    const root = tempDir();
    const memory = new MemorySource();
    memory.set(
      "lib",
      `kind: Telo.Library
metadata:
  name: Lib
  version: 1.0.0
exports:
  resources: [double]
---
kind: Telo.Function
metadata:
  name: double
params:
  - name: x
    schema: { type: integer }
returns:
  schema: { type: integer }
body: !cel "x * 2"
`,
    );
    memory.set(
      "app",
      `kind: Telo.Application
metadata:
  name: App
  version: 1.0.0
imports:
  Lib: memory://lib
---
kind: Telo.Function
metadata:
  name: quadruple
params:
  - name: x
    schema: { type: integer }
returns:
  schema: { type: integer }
body: !cel "Lib.double(Lib.double(x))"
`,
    );

    const kernel = new Kernel({ sources: [memory], env: {} });
    await kernel.load("memory://app", { cacheDir: root });
    await kernel.start();

    expect(kernel.exitCode).toBe(0);
    expect(storedModules(root)).toHaveLength(2);
  });
});
