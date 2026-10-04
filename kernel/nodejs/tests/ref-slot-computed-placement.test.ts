import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { afterAll, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import { KernelRuntimeSeam } from "../src/runtime-seam.js";

/**
 * EVERY PLACEMENT OF AN EXPRESSION RELATIVE TO A REFERENCE SLOT, checked by
 * `telo check` over a library's provider resource and refused by the kernel's
 * compile-eval expansion from a consumer whose own check is silent about it:
 * the positions `telo check` reports are exactly the positions the kernel
 * refuses (`REF_SLOT_COMPUTED` / `ERR_REF_SLOT_COMPUTED`, one reader —
 * `computedRefSlots`).
 *
 * A `Telo.Provider`'s whole root is implicitly compile-eval, which is what makes
 * every field here an eval site and is why this position went unreported until
 * the rule was stated: the expression was legal CEL in a legal place, and only
 * the slot beneath it made it wrong.
 *
 * The negative placements are the point of the rule being keyed on PROVENANCE
 * rather than shape: a reference, an inline declaration, raw JSON Schema at a
 * type slot and a value-branch scalar all stay at reference slots and must
 * create and run unchanged. `span-attribute-placement.test.ts` is the shape
 * this follows.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const RUN = pathToFileURL(path.resolve(here, "../../../modules/run")).href;
const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "telo-ref-slot-computed-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A slot accepting an executable, by itself and inside the shapes the
 *  reference reach walks. */
const HANDLER = `x-telo-ref: { kind: Telo.Invocable, use: call }`;

interface Placement {
  name: string;
  /** The kind's `schema:`, indented under it. */
  schema: string;
  /** The resource's own fields, at the document root. */
  body: string;
  /** `[code, path]` `telo check` reports, at the expression it names. */
  expected: Array<[string, string]>;
}

const placements: Placement[] = [
  {
    name: "at the slot itself",
    schema: `type: object
properties:
  handler: { ${HANDLER} }`,
    body: `handler: !cel "'target'"`,
    expected: [["REF_SLOT_COMPUTED", "handler"]],
  },
  {
    name: "above a list of slots",
    schema: `type: object
properties:
  routes:
    type: array
    items:
      type: object
      properties:
        handler: { ${HANDLER} }`,
    body: `routes: !cel "[{'handler': 'target'}]"`,
    expected: [["REF_SLOT_COMPUTED", "routes"]],
  },
  {
    name: "at a list item above the slot",
    schema: `type: object
properties:
  routes:
    type: array
    items:
      type: object
      properties:
        handler: { ${HANDLER} }`,
    body: `routes:
  - !cel "{'handler': 'target'}"`,
    expected: [["REF_SLOT_COMPUTED", "routes[0]"]],
  },
  {
    name: "behind a local $ref",
    schema: `type: object
properties:
  route: { $ref: "#/$defs/Route" }
$defs:
  Route:
    type: object
    properties:
      handler: { ${HANDLER} }`,
    body: `route: !cel "{'handler': 'target'}"`,
    expected: [["REF_SLOT_COMPUTED", "route"]],
  },
  {
    name: "at depth in a recursive shape",
    schema: `type: object
properties:
  node: { $ref: "#/$defs/Node" }
$defs:
  Node:
    type: object
    properties:
      handler: { ${HANDLER} }
      next: { $ref: "#/$defs/Node" }`,
    body: `node:
  next: !cel "{'handler': 'target'}"`,
    expected: [["REF_SLOT_COMPUTED", "node.next"]],
  },
  {
    name: "a reference",
    schema: `type: object
properties:
  handler: { ${HANDLER} }`,
    body: `handler: !ref target`,
    expected: [],
  },
  {
    name: "an inline declaration",
    schema: `type: object
properties:
  handler: { ${HANDLER} }`,
    body: `handler:
  kind: Run.Value
  value: 1`,
    expected: [],
  },
  {
    name: "raw JSON Schema at a type slot",
    schema: `type: object
properties:
  shape:
    x-telo-ref: { kind: Telo.JsonSchema, use: schema }`,
    body: `shape:
  type: object
  properties:
    id: { type: string }`,
    expected: [],
  },
  {
    name: "a value-branch scalar",
    schema: `type: object
properties:
  target:
    anyOf:
      - { const: none }
      - { ${HANDLER} }`,
    body: `target: none`,
    expected: [],
  },
  {
    name: "an expression beside a slot, not above one",
    schema: `type: object
properties:
  handler: { ${HANDLER} }
  label: { type: string }`,
    body: `handler: !ref target
label: !cel "'hello'"`,
    expected: [],
  },
];

function write(placement: Placement, index: number): { library: string; app: string } {
  const root = path.join(dir, String(index));
  mkdirSync(path.join(root, "lib"), { recursive: true });
  const library = path.join(root, "lib", "telo.yaml");
  writeFileSync(
    library,
    `kind: Telo.Library
metadata:
  name: Placement
imports:
  Run: ${RUN}
exports:
  resources: [probe]
---
kind: Telo.Definition
metadata:
  name: Bus
capability: Telo.Provider
schema:
${placement.schema.replace(/^/gm, "  ")}
resources:
  - kind: Run.Value
    metadata: { name: reading }
    value: !cel "1"
provide: !ref reading
---
kind: Self.Bus
metadata:
  name: bus
${placement.body}
---
kind: Run.Value
metadata:
  name: target
value: 1
---
kind: Run.Sequence
metadata:
  name: probe
steps:
  - name: read
    value: !cel "1"
`,
  );
  const app = path.join(root, "telo.yaml");
  writeFileSync(
    app,
    `kind: Telo.Application
metadata:
  name: PlacementApp
imports:
  Lib: ./lib
targets:
  - !ref Lib.probe
`,
  );
  return { library, app };
}

async function checked(library: string): Promise<Array<{ code: string; path: string; message: string }>> {
  const seam = new KernelRuntimeSeam(new Kernel({ sources: [new LocalFileSource()], env: {} }));
  const result = await seam.check(library);
  expect(result.loadError).toBeUndefined();
  return result.diagnostics
    .filter((d) => d.code === "REF_SLOT_COMPUTED")
    .map((d) => ({ code: String(d.code), path: String(d.path), message: d.message }));
}

/** The reasons the kernel refused a resource for; empty when the app ran. An
 *  init failure keeps its leaves structured, so the refusal is read off the
 *  diagnostic tree rather than out of rendered text. */
async function refused(app: string): Promise<string[]> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  try {
    await kernel.load(app);
    await kernel.boot();
    await kernel.runTargets();
    return [];
  } catch (error) {
    const out: string[] = [];
    const walk = (node: any): void => {
      if (!node || typeof node !== "object") return;
      if (node.code === "ERR_REF_SLOT_COMPUTED" && typeof node.message === "string") {
        out.push(node.message.replace(/^RuntimeError: /, ""));
      }
      for (const child of [...(node.diagnostics ?? []), ...(node.children ?? [])]) walk(child);
      walk(node.cause);
    };
    walk(error);
    if (out.length === 0) throw error;
    return out;
  } finally {
    await kernel.teardown();
  }
}

/** `telo check` prefixes its subject with the kind as WRITTEN (`Self.Bus/bus`)
 *  and the kernel with the canonical one; the reason after the colon is the
 *  shared text, and that is what the two halves must agree on. */
const reasons = (messages: string[]): string[] =>
  messages.map((message) => message.slice(message.indexOf(": ") + 2)).sort();

describe("an expression at or above a reference slot", () => {
  placements.forEach((placement, index) => {
    it(`${placement.name}: telo check reports what the kernel refuses`, async () => {
      const { library, app } = write(placement, index);
      const analyzer = await checked(library);
      const kernel = await refused(app);

      expect(analyzer.map(({ code, path }) => [code, path])).toEqual(placement.expected);
      expect(reasons(analyzer.map((d) => d.message))).toEqual(reasons(kernel));
    });
  });
});
