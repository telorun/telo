import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const RUN = path.resolve(here, "../../../modules/run");
const TARGET = "SequenceSeqSteps0First";

/** One sequence whose only step dispatches an inline target. */
function appYaml(value: number): string {
  return `kind: Telo.Application
metadata:
  name: InlineStepReconcile
  version: 1.0.0
imports:
  Run: ${RUN}
---
kind: Run.Sequence
metadata:
  name: seq
steps:
  - name: first
    invoke:
      kind: Run.Value
      value: ${value}
`;
}

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function bootApp(value: number): Promise<{ kernel: Kernel; appPath: string }> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-inline-step-")));
  dirs.push(dir);
  const appPath = path.join(dir, "telo.yaml");
  await fs.writeFile(appPath, appYaml(value));
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(appPath);
  await kernel.boot();
  return { kernel, appPath };
}

describe("an inline step target is a declaration of its own", () => {
  it("is rebuilt by a reconciliation that edits it, instead of colliding with itself", async () => {
    // When the composer registered its target at init(), an edit re-created the
    // composer, which registered the target a second time beside the first —
    // ERR_DUPLICATE_RESOURCE, and a kernel left half-reconciled.
    const { kernel, appPath } = await bootApp(1);
    await fs.writeFile(appPath, appYaml(2));

    const outcome = await kernel.reconcile();

    expect(outcome.restartRequired).toBeUndefined();
    // The sequence holds a reference to its target now, so it is rebuilt with it,
    // dependency first.
    expect(outcome.reinitialized).toEqual([TARGET, "seq"]);
    const root = (kernel as unknown as { rootContext: any }).rootContext;
    expect(root.resourceInstances.get(TARGET)?.resource.value).toBe(2);
    await kernel.teardown();
  });

  it("tears down after the sequence that dispatches it", async () => {
    // The sequence names its target from the moment it is created, so the
    // cascade sees the edge and unwinds the consumer first. Registered at init()
    // instead, the target had no edge and went first, on insertion order alone.
    const { kernel } = await bootApp(1);
    const order: string[] = [];
    kernel.on("*", (event) => {
      const name = String(event.name);
      if (!name.endsWith(".Teardown")) return;
      if (name.includes(TARGET)) order.push(TARGET);
      else if (name.includes("seq")) order.push("seq");
    });

    await kernel.teardown();

    expect(order).toEqual(["seq", TARGET]);
  });
});
