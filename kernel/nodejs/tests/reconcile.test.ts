import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { afterEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(here, "__fixtures__/teardown-order");
/** Each test gets its OWN copy of the fixture library, because the journal it
 *  records into is module scope: one library path is one module instance, and
 *  every app importing it would otherwise share — and accumulate — one journal. */
const LIB = "./lib/telo.yaml";

/** Three nodes: `beta` holds `alpha`, `solo` holds nothing. Each records its
 *  label when it initializes and `~label` when its inverse runs, so a
 *  reconciliation is readable as a sequence. */
function appYaml(labels: { alpha: string; beta: string; solo?: string }): string {
  const solo =
    labels.solo === undefined
      ? ""
      : `---\nkind: Fixture.Node\nmetadata:\n  name: solo\nlabel: ${labels.solo}\n`;
  return `kind: Telo.Application
metadata:
  name: ReconcileApp
  version: 1.0.0
imports:
  Fixture: ${LIB}
---
kind: Fixture.Node
metadata:
  name: alpha
label: ${labels.alpha}
---
kind: Fixture.Node
metadata:
  name: beta
label: ${labels.beta}
holds: !ref alpha
${solo}`;
}

const dirs: string[] = [];

/**
 * A temp directory holding its own copy of the fixture library.
 *
 * `realpath` is not optional: on Windows `os.tmpdir()` is an 8.3 short path
 * (`C:\\Users\\RUNNER~1\\...`), and the `~` percent-encodes into the file URL the
 * controller loader imports, which then resolves to nothing. Resolving to the
 * long form first is what the cache-root and legacy-cache tests do for the same
 * reason.
 */
async function workspace(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-reconcile-")));
  dirs.push(dir);
  await fs.cp(LIB_DIR, path.join(dir, "lib"), { recursive: true });
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function bootApp(labels: { alpha: string; beta: string; solo?: string }): Promise<{
  kernel: Kernel;
  appPath: string;
  /** Journal entries recorded since this boot. */
  since: () => Promise<string[]>;
  write: (next: { alpha: string; beta: string; solo?: string }) => Promise<void>;
}> {
  const dir = await workspace();
  const appPath = path.join(dir, "telo.yaml");
  await fs.writeFile(appPath, appYaml(labels));

  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  await kernel.load(appPath);
  await kernel.boot();

  const ctx = (kernel as unknown as { rootContext: any }).rootContext;
  const journal = ctx.resolveImportedInstance("Fixture", "journal");

  return {
    kernel,
    appPath,
    // Every entry here is this app's own: the library was copied into this
    // test's temp directory, so its controller is a module URL of its own.
    // The library's `provider` node writes to the same journal and belongs to
    // no test, so it is dropped rather than counted into every offset.
    since: async () =>
      ((await journal.provide()) as { entries: string[] }).entries.filter(
        (e) => e !== "provider" && e !== "~provider",
      ),
    write: async (next) => fs.writeFile(appPath, appYaml(next)),
  };
}

describe("reconcile — rebuild what moved, leave the rest running", () => {
  it("rebuilds a changed resource and everything holding it, in order", async () => {
    const app = await bootApp({ alpha: "alpha1", beta: "beta1", solo: "solo1" });
    // `beta` holds `alpha`, so it defers past `solo` until `alpha` is in.
    expect(await app.since()).toEqual(["alpha1", "solo1", "beta1"]);

    await app.write({ alpha: "alpha2", beta: "beta1", solo: "solo1" });
    const outcome = await app.kernel.reconcile();

    expect(outcome.restartRequired).toBeUndefined();
    // `beta` holds `alpha`, so it cannot survive alpha being replaced.
    expect([...outcome.reinitialized].sort()).toEqual(["alpha", "beta"]);
    expect(outcome.removed).toEqual([]);

    // Unwound consumer-first, rebuilt dependency-first, and `solo` never moved.
    expect((await app.since()).slice(3)).toEqual(["~beta1", "~alpha1", "alpha2", "beta1"]);
    await app.kernel.teardown();
  });

  it("leaves an unrelated resource's instance alone", async () => {
    const app = await bootApp({ alpha: "alpha1", beta: "beta1", solo: "solo1" });
    await app.write({ alpha: "alpha1", beta: "beta2", solo: "solo1" });
    const outcome = await app.kernel.reconcile();

    // Nothing holds `beta`, so the closure stops there.
    expect(outcome.reinitialized).toEqual(["beta"]);
    expect((await app.since()).slice(3)).toEqual(["~beta1", "beta2"]);
    await app.kernel.teardown();
  });

  it("unwinds a removed resource without replacing it", async () => {
    const app = await bootApp({ alpha: "alpha1", beta: "beta1", solo: "solo1" });
    await app.write({ alpha: "alpha1", beta: "beta1" });
    const outcome = await app.kernel.reconcile();

    expect(outcome.removed).toEqual(["solo"]);
    expect(outcome.reinitialized).toEqual([]);
    expect((await app.since()).slice(3)).toEqual(["~solo1"]);
    await app.kernel.teardown();
  });

  it("initializes a resource that was added", async () => {
    const app = await bootApp({ alpha: "alpha1", beta: "beta1" });
    await app.write({ alpha: "alpha1", beta: "beta1", solo: "solo1" });
    const outcome = await app.kernel.reconcile();

    expect(outcome.reinitialized).toEqual(["solo"]);
    expect((await app.since()).slice(2)).toEqual(["solo1"]);
    await app.kernel.teardown();
  });

  it("still compares a resource whose ref slots are NESTED as unchanged", async () => {
    // A resource is diffed against the manifest the kernel registered, and
    // Phase-5 injection writes live instances into ref slots. The create-time
    // expansion copies a resource shallowly, so a slot nested inside an array
    // is the case where the registered object could be written through — and a
    // manifest holding an instance renders opaque, which would report every
    // composite resource as changed on every reconcile and restart everything
    // above it. Locked here because nothing else would notice it happening.
    const dir = await workspace();
    const appPath = path.join(dir, "telo.yaml");
    await fs.writeFile(
      appPath,
      `kind: Telo.Application\nmetadata:\n  name: NestedApp\n  version: 1.0.0\nimports:\n  Fixture: ${LIB}\n---\nkind: Fixture.Node\nmetadata:\n  name: alpha\nlabel: alpha\n---\nkind: Fixture.Group\nmetadata:\n  name: gamma\nlabel: gamma\nmembers:\n  - node: !ref alpha\n`,
    );

    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(appPath);
    await kernel.boot();

    // Twice, because the first pass replaces the manifest set the second one
    // compares against.
    expect(await kernel.reconcile()).toEqual({ reinitialized: [], removed: [] });
    expect(await kernel.reconcile()).toEqual({ reinitialized: [], removed: [] });
    await kernel.teardown();
  });

  it("rebuilds a resource that READ its provider through CEL", async () => {
    // `!cel "resources.alpha.label"` is expanded and baked into the reader's
    // config at create time, leaving no reference behind — so without a read
    // edge the reader keeps serving the previous load's value, is absent from
    // `reinitialized`, and nothing says so. Silence is the one outcome this
    // mechanism must not produce.
    const dir = await workspace();
    const appPath = path.join(dir, "telo.yaml");
    const withLabel = (label: string): string =>
      `kind: Telo.Application\nmetadata:\n  name: ReaderApp\n  version: 1.0.0\nimports:\n  Fixture: ${LIB}\n---\nkind: Fixture.Node\nmetadata:\n  name: alpha\nlabel: ${label}\n---\nkind: Fixture.Node\nmetadata:\n  name: reader\nlabel: !cel "'from-' + resources.alpha.label"\n`;
    await fs.writeFile(appPath, withLabel("a1"));

    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(appPath);
    await kernel.boot();
    const ctx = (kernel as unknown as { rootContext: any }).rootContext;
    const journal = ctx.resolveImportedInstance("Fixture", "journal");
    const entries = async (): Promise<string[]> =>
      ((await journal.provide()) as { entries: string[] }).entries.filter((e) => e !== "provider");
    expect(await entries()).toEqual(["a1", "from-a1"]);

    await fs.writeFile(appPath, withLabel("a2"));
    const outcome = await kernel.reconcile();

    expect([...outcome.reinitialized].sort()).toEqual(["alpha", "reader"]);
    expect((await entries()).slice(2)).toEqual(["~from-a1", "~a1", "a2", "from-a2"]);
    await kernel.teardown();
  });

  it("reports nothing to do when the file did not change", async () => {
    const app = await bootApp({ alpha: "alpha1", beta: "beta1" });
    const outcome = await app.kernel.reconcile();

    expect(outcome).toEqual({ reinitialized: [], removed: [] });
    expect((await app.since()).slice(2)).toEqual([]);
    await app.kernel.teardown();
  });

  it("refuses to touch a boot target, and never sweeps the application document", async () => {
    // Two guards cover this and the document one is first: the app doc HOLDS its
    // targets, so the closure reaches it — and it is the one resource nothing
    // here can rebuild, since only `installManifests` re-applies the targets,
    // module metadata, environment and logging it carries. Behind it, the
    // started guard would refuse the target itself: `runTargets()` is once per
    // kernel, so a rebuilt target would be left constructed and idle.
    const dir = await workspace();
    const appPath = path.join(dir, "telo.yaml");
    const withLabel = (label: string): string =>
      `kind: Telo.Application\nmetadata:\n  name: TaskApp\n  version: 1.0.0\nimports:\n  Fixture: ${LIB}\ntargets:\n  - !ref job\n---\nkind: Fixture.Task\nmetadata:\n  name: job\nlabel: ${label}\n`;
    await fs.writeFile(appPath, withLabel("job1"));

    const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
    await kernel.load(appPath);
    await kernel.boot();
    await kernel.runTargets();
    const ctx = (kernel as unknown as { rootContext: any }).rootContext;
    const journal = ctx.resolveImportedInstance("Fixture", "journal");
    const entries = async (): Promise<string[]> =>
      ((await journal.provide()) as { entries: string[] }).entries.filter((e) => e !== "provider");
    expect(await entries()).toEqual(["job1", "run:job1"]);

    await fs.writeFile(appPath, withLabel("job2"));
    const outcome = await kernel.reconcile();

    expect(outcome.restartRequired).toBe("the application document is in the impact set");
    // The guard behind it, still true of the same edit.
    expect(ctx.wasStarted("job")).toBe(true);
    // Untouched: still the instance that is running.
    expect(await entries()).toEqual(["job1", "run:job1"]);
    await kernel.teardown();
  });

  it("refuses to narrow a change inside an imported library", async () => {
    const app = await bootApp({ alpha: "alpha1", beta: "beta1" });
    const libPath = path.join(path.dirname(app.appPath), "lib", "telo.yaml");
    const lib = await fs.readFile(libPath, "utf8");
    await fs.writeFile(libPath, lib.replace("version: 1.0.0", "version: 1.0.1"));

    const outcome = await app.kernel.reconcile();
    // A library's resources live in the child context its import owns and never
    // reach the entry-only manifest set the resource diff walks, so there is
    // nothing here to narrow against.
    expect(outcome.restartRequired).toContain("an imported module changed");
    expect(await app.since()).toEqual(["alpha1", "beta1"]);
    await app.kernel.teardown();
  });

  it("refuses to narrow an application-document change", async () => {
    const app = await bootApp({ alpha: "alpha1", beta: "beta1" });
    const text = await fs.readFile(app.appPath, "utf8");
    await fs.writeFile(app.appPath, text.replace("version: 1.0.0", "version: 1.0.1"));

    const outcome = await app.kernel.reconcile();
    // `variables` / `ports` / `logging` are resolved once for the whole
    // application, so a change here has no bounded impact set.
    expect(outcome.restartRequired).toBe("the application document changed");
    // Nothing was unwound.
    expect((await app.since()).slice(2)).toEqual([]);
    await app.kernel.teardown();
  });
});
