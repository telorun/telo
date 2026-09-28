import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { afterAll, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import { KernelRuntimeSeam } from "../src/runtime-seam.js";

/**
 * `x-telo-span-attribute` placements, each checked by `telo check` over a
 * library's contract and dispatched by the kernel from a consumer whose own
 * check is silent about it: the problems `telo check` reports are exactly the
 * problems the kernel refuses the contract for (`kernel/specs/tracing.md` §5).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const RUN = pathToFileURL(path.resolve(here, "../../../modules/run")).href;
const dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), "telo-span-placement-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const TURN_SHAPE = `---
kind: Telo.JsonSchema
metadata:
  name: Turn
schema:
  type: object
  properties:
    id: { type: string, x-telo-span-attribute: app.turn.id }
`;

interface Placement {
  name: string;
  /** The probe's `inputType.schema`, indented under it. */
  schema: string;
  shapes?: string;
  /** `[code, path]` `telo check` reports, at the node it names. */
  expected: Array<[string, string]>;
}

const S = "inputType.schema";

const placements: Placement[] = [
  {
    name: "a scalar property",
    schema: `type: object
properties:
  id: { type: string, x-telo-span-attribute: app.id }`,
    expected: [],
  },
  {
    name: "a $defs entry a property references",
    schema: `type: object
properties:
  turn: { $ref: "#/$defs/Turn" }
$defs:
  Turn:
    type: object
    properties:
      id: { type: string, x-telo-span-attribute: app.turn.id }`,
    expected: [],
  },
  {
    name: "a named shape a property references",
    schema: `type: object
properties:
  turn: !ref Turn`,
    shapes: TURN_SHAPE,
    expected: [],
  },
  {
    name: "beside a $ref",
    schema: `type: object
properties:
  id: { $ref: "#/$defs/Id", x-telo-span-attribute: app.id }
$defs:
  Id: { type: string }`,
    expected: [],
  },
  {
    name: "the contract root",
    schema: `type: object
x-telo-span-attribute: app.whole
properties:
  id: { type: string }`,
    expected: [["SPAN_ATTRIBUTE_MISPLACED", "inputType"]],
  },
  {
    name: "an array item",
    schema: `type: object
properties:
  tags:
    type: array
    items: { type: string, x-telo-span-attribute: app.tag }`,
    expected: [["SPAN_ATTRIBUTE_MISPLACED", `${S}.properties.tags`]],
  },
  {
    name: "a named shape an array item references",
    schema: `type: object
properties:
  turns:
    type: array
    items: !ref Turn`,
    shapes: TURN_SHAPE,
    expected: [["SPAN_ATTRIBUTE_MISPLACED", `${S}.properties.turns`]],
  },
  {
    name: "a map value",
    schema: `type: object
properties:
  labels:
    type: object
    additionalProperties: { type: string, x-telo-span-attribute: app.label }`,
    expected: [["SPAN_ATTRIBUTE_MISPLACED", `${S}.properties.labels`]],
  },
  {
    name: "a non-scalar property in a $defs entry",
    schema: `type: object
properties:
  report: { $ref: "#/$defs/Report" }
$defs:
  Report:
    type: object
    x-telo-span-attribute: app.report`,
    expected: [["SPAN_ATTRIBUTE_MISPLACED", `${S}.$defs.Report`]],
  },
  {
    name: "beside x-telo-sensitive",
    schema: `type: object
properties:
  token: { type: string, x-telo-sensitive: true, x-telo-span-attribute: app.token }`,
    expected: [["SPAN_ATTRIBUTE_MISPLACED", `${S}.properties.token`]],
  },
  {
    name: "a malformed name",
    schema: `type: object
properties:
  id: { type: string, x-telo-span-attribute: Turn-Id }`,
    expected: [["SPAN_ATTRIBUTE_INVALID", `${S}.properties.id`]],
  },
  {
    name: "a name the runtime sets itself",
    schema: `type: object
properties:
  kind: { type: string, x-telo-span-attribute: telo.resource.kind }`,
    expected: [["SPAN_ATTRIBUTE_INVALID", `${S}.properties.kind`]],
  },
];

function write(placement: Placement, index: number): { library: string; app: string } {
  const root = path.join(dir, String(index));
  mkdirSync(path.join(root, "lib"), { recursive: true });
  const schema = placement.schema.replace(/^/gm, "    ");
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
${placement.shapes ?? ""}---
kind: Run.Value
metadata:
  name: probe
inputType:
  kind: Telo.JsonSchema
  schema:
${schema}
value: { ok: true }
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
  - invoke: !ref Lib.probe
    inputs: {}
`,
  );
  return { library, app };
}

type Problem = { code: string; message: string };

async function checked(library: string): Promise<Array<Problem & { path: string }>> {
  const seam = new KernelRuntimeSeam(new Kernel({ sources: [new LocalFileSource()], env: {} }));
  const result = await seam.check(library);
  expect(result.loadError).toBeUndefined();
  return result.diagnostics
    .filter((d) => String(d.code).startsWith("SPAN_ATTRIBUTE_"))
    .map((d) => ({
      code: String(d.code),
      path: String(d.path),
      message: d.message.replace(/\.$/, ""),
    }));
}

/** The problems the kernel refused the contract for; empty when it ran. */
async function refused(app: string): Promise<Problem[]> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  try {
    await kernel.load(app);
    await kernel.boot();
    await kernel.runTargets();
    return [];
  } catch (error) {
    for (let e: any = error; e; e = e.cause) {
      if (e.code === "ERR_SPAN_ATTRIBUTE_INVALID") return (e.data as { problems: Problem[] }).problems;
    }
    throw error;
  } finally {
    await kernel.teardown();
  }
}

const sorted = (problems: Problem[]): string[] =>
  problems.map(({ code, message }) => `${code}: ${message}`).sort();

describe("x-telo-span-attribute placements", () => {
  placements.forEach((placement, index) => {
    it(`${placement.name}: telo check reports what the kernel refuses`, async () => {
      const { library, app } = write(placement, index);
      const analyzer = await checked(library);
      const kernel = await refused(app);

      expect(analyzer.map(({ code, path }) => [code, path])).toEqual(placement.expected);
      expect(sorted(analyzer)).toEqual(sorted(kernel));
    });
  });
});
