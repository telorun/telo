import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";
import { KernelRuntimeSeam } from "../src/runtime-seam.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(here, "__fixtures__/kernel-instance-id");

function appYaml(label: string): string {
  return `kind: Telo.Application
metadata:
  name: KernelInstanceIdApp
  version: 1.0.0
imports:
  Probe: ./lib/telo.yaml
targets: [!ref report]
---
kind: Probe.Probe
metadata:
  name: local
label: ${label}
---
kind: Probe.Report
metadata:
  name: report
`;
}

const dirs: string[] = [];

/** `realpath` because Windows' 8.3 temp path percent-encodes into the module URL. */
async function writeApp(label: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-kernel-instance-id-")));
  dirs.push(dir);
  await fs.cp(LIB_DIR, path.join(dir, "lib"), { recursive: true });
  const appPath = path.join(dir, "telo.yaml");
  await fs.writeFile(appPath, appYaml(label));
  return appPath;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function bootKernel(appPath: string): Promise<Kernel> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(appPath);
  await kernel.boot();
  return kernel;
}

type Root = {
  resourceInstances: Map<string, { instance: { provide(): Promise<{ kernelInstanceId: string }> } }>;
  resolveImportedInstance(alias: string, name: string): { provide(): Promise<{ kernelInstanceId: string }> };
};

function root(kernel: Kernel): Root {
  return (kernel as unknown as { rootContext: Root }).rootContext;
}

async function localId(kernel: Kernel): Promise<string> {
  return (await root(kernel).resourceInstances.get("local")!.instance.provide()).kernelInstanceId;
}

describe("ctx.kernelInstanceId", () => {
  it("is one id across an application's modules and another in a second kernel", async () => {
    const appPath = await writeApp("one");
    const first = await bootKernel(appPath);
    const second = await bootKernel(appPath);

    const ownId = await localId(first);
    const importedId = (await root(first).resolveImportedInstance("Probe", "probe").provide()).kernelInstanceId;
    expect(typeof ownId).toBe("string");
    expect(ownId.length).toBeGreaterThan(0);
    expect(importedId).toBe(ownId);
    expect(await localId(second)).not.toBe(ownId);

    await first.teardown();
    await second.teardown();
  }, 30_000);

  it("is kept by a reconcile that re-creates the resource", async () => {
    const appPath = await writeApp("one");
    const kernel = await bootKernel(appPath);
    const before = await localId(kernel);
    const instanceBefore = root(kernel).resourceInstances.get("local")!.instance;

    await fs.writeFile(appPath, appYaml("two"));
    const outcome = await kernel.reconcile();

    expect(outcome.restartRequired).toBeUndefined();
    expect(outcome.reinitialized).toContain("local");
    expect(root(kernel).resourceInstances.get("local")!.instance).not.toBe(instanceBefore);
    expect(await localId(kernel)).toBe(before);

    await kernel.teardown();
  }, 30_000);

  it("differs in a child application started through the runtime seam", async () => {
    const appPath = await writeApp("one");
    const parent = await bootKernel(appPath);
    const parentId = await localId(parent);
    expect(typeof parentId).toBe("string");

    const run = await new KernelRuntimeSeam(parent).run(appPath);
    let stdout = "";
    for await (const chunk of run.stdout) stdout += chunk;
    let stderr = "";
    for await (const chunk of run.stderr) stderr += chunk;
    expect(await run.exitCode, stderr).toBe(0);

    const childId = stdout.trim();
    expect(childId.length).toBeGreaterThan(0);
    expect(childId).not.toBe(parentId);

    await parent.teardown();
  }, 30_000);
});
