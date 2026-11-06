import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  AnalysisRegistry,
  collectModuleDocuments,
  flattenForAnalyzer,
  importPathOf,
  StaticAnalyzer,
  type CallGraph,
  type ResourceGraphNode,
} from "@telorun/analyzer";
import type { ResourceManifest } from "@telorun/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { Kernel } from "../src/kernel.js";
import { LocalFileSource } from "../src/manifest-sources/local-file-source.js";

/**
 * `ctx.resolveCoReferrers(slot)` — the live co-referrers of a `callsCoReferrers`
 * slot's target, answered at dispatch from the index the kernel builds once the
 * application has initialized and again after a reconcile. The fixture's
 * announcer runs each one through the kernel and returns their labels in order.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "__fixtures__/co-referrers");

const kernels: Kernel[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.teardown();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function boot(entry: string): Promise<Kernel> {
  const kernel = new Kernel({ sources: [new LocalFileSource()], env: {} });
  kernels.push(kernel);
  await kernel.load(entry);
  await kernel.boot();
  return kernel;
}

type Root = {
  resolveImportedInstance(alias: string, name: string): unknown;
  invokeResolved(kind: string, name: string, instance: unknown, inputs: unknown): Promise<{ ran: string[] }>;
};
const rootOf = (kernel: Kernel) => (kernel as unknown as { rootContext: Root }).rootContext;

/** Dispatches an imported library's own announcer, as its importer would. */
async function announceIn(kernel: Kernel, alias: string): Promise<string[]> {
  const root = rootOf(kernel);
  const instance = root.resolveImportedInstance(alias, "announce");
  return (await root.invokeResolved("CoKinds.Announce", "announce", instance, {})).ran;
}

describe("ctx.resolveCoReferrers", () => {
  it("lists the root, then its imports depth-first in imports: order, each in document order", async () => {
    const kernel = await boot(path.join(FIXTURES, "order/telo.yaml"));
    const expected = ["rootFirst", "rootSecond", "rootPartial", "events", "a", "a1", "b"];
    const { ran } = await kernel.invoke({ kind: "Co.Announce", name: "announceJoined" }, {});
    expect(ran).toEqual(expected);
    // The shared library's own announcer names the same topic, so the same set.
    expect(await announceIn(kernel, "Events")).toEqual(expected);
  }, 60_000);

  it("calls exactly the co-referrers the call graph lists, in its order", async () => {
    const kernel = await boot(path.join(FIXTURES, "agreement/telo.yaml"));

    // What `telo check` builds over the same load: the call-graph edges the
    // announcer's slot adds, each named by its module instance.
    const graph = kernel.getLoadedGraph()!;
    const flattened = flattenForAnalyzer(graph);
    const registry = new AnalysisRegistry();
    const analyzer = new StaticAnalyzer();
    analyzer.analyze(flattened, { moduleDocuments: collectModuleDocuments(graph) }, registry);
    const manifests = analyzer.normalize(flattened, registry);
    const callGraph = (registry.analysisOf(manifests) as unknown as { callGraph: CallGraph }).callGraph;
    const instancePath = (manifest: ResourceManifest): string[] => {
      const module = (manifest.metadata as { module?: string }).module;
      return [...(importPathOf(manifest) ?? (module === "CoAgreement" ? [] : [module!]))];
    };
    const announcer = callGraph.resource("Co.Announce", "announceJoined")!;
    const listed = callGraph
      .edgesFrom(announcer.id)
      .filter((edge) => edge.coReferrer)
      .map((edge) => {
        const node = callGraph.nodes.get(edge.to!) as ResourceGraphNode;
        return [...instancePath(node.manifest), node.name].join(".");
      });

    // What the running announcer's `ctx.resolveCoReferrers` answers, each live
    // instance named by the module context holding it.
    type Context = {
      needPath: readonly string[];
      resourceInstances: Map<string, { instance: unknown }>;
      ownDeclarations(): Array<[string, ResourceManifest]>;
      importedLibrary(alias: string): Context | undefined;
    };
    const named = new Map<unknown, string>();
    const walk = (context: Context): void => {
      for (const [name, { instance }] of context.resourceInstances) {
        named.set(instance, [...context.needPath, name].join("."));
      }
      for (const [alias, manifest] of context.ownDeclarations()) {
        if (manifest.kind !== "Telo.Import") continue;
        const library = context.importedLibrary(alias);
        if (library) walk(library);
      }
    };
    const root = rootOf(kernel) as unknown as Context;
    walk(root);
    const announce = root.resourceInstances.get("announceJoined")!.instance as {
      coReferrersAt(slot: string): Array<{ instance: unknown }>;
    };
    const dispatched = announce.coReferrersAt("/topic").map(({ instance }) => named.get(instance));

    expect(dispatched).toEqual([
      "rootFirst",
      "rootSecond",
      "CoEvents.eventsOwn",
      "TwiceA.twiceListener",
      "TwiceA.Inner.innerListener",
      "TwiceB.twiceListener",
      "TwiceB.Inner.innerListener",
    ]);
    expect(listed).toEqual(dispatched);
  }, 60_000);

  it("reads an inherited slot's kinds in the module that wrote them", async () => {
    const kernel = await boot(path.join(FIXTURES, "order/telo.yaml"));
    const { ran } = await kernel.invoke({ kind: "Self.Shout", name: "shoutJoined" }, {});
    expect(ran).toEqual(["rootFirst", "rootSecond", "rootPartial", "events", "a", "a1", "b"]);
  }, 60_000);

  it("includes a template instance's body entries, a family in family order", async () => {
    const kernel = await boot(path.join(FIXTURES, "order/telo.yaml"));
    const { ran } = await kernel.invoke({ kind: "Co.Channel", name: "channel" }, {});
    expect(ran).toEqual(["x", "y", "z"]);
  }, 60_000);

  it("matches a topic in the module instance its reference reaches", async () => {
    const isolated = await boot(path.join(FIXTURES, "isolated.yaml"));
    expect(await announceIn(isolated, "First")).toEqual(["first"]);
    expect(await announceIn(isolated, "Second")).toEqual(["second"]);

    const shared = await boot(path.join(FIXTURES, "shared.yaml"));
    expect(await announceIn(shared, "First")).toEqual(["first", "second"]);
    expect(await announceIn(shared, "Second")).toEqual(["first", "second"]);
  }, 60_000);

  it("gives each co-referrer a dispatch span of its own, a child of the caller's", async () => {
    const kernel = await boot(path.join(FIXTURES, "isolated.yaml"));
    kernel.setTracing(true);
    const spans: Array<{ name: string; spanId?: string; parentSpanId?: string }> = [];
    kernel.on("*", (event) => {
      if (!event.name.endsWith(".Invoked")) return;
      const payload = event.payload as { spanId?: string; parentSpanId?: string };
      spans.push({ name: event.name, spanId: payload.spanId, parentSpanId: payload.parentSpanId });
    });
    await announceIn(kernel, "First");
    const caller = spans.find((span) => span.name.includes("announce"))!;
    expect(spans.filter((span) => span.parentSpanId === caller.spanId).map((span) => span.name)).toEqual([
      expect.stringContaining("onFirst"),
    ]);
  }, 60_000);

  it("refuses a pointer that is no callsCoReferrers slot of the caller's kind", async () => {
    const kernel = await boot(path.join(FIXTURES, "isolated.yaml"));
    const root = rootOf(kernel) as unknown as { resourceInstances: Map<string, { instance: unknown }> };
    // The listener's own `topic` slot declares no `callsCoReferrers`.
    const listener = root.resourceInstances.get("onFirst")!.instance as {
      coReferrersAt(slot: string): unknown;
    };
    expect(() => listener.coReferrersAt("/topic")).toThrowError(
      expect.objectContaining({
        code: "ERR_REF_UNRESOLVED",
        message: expect.stringContaining("'/topic' is not a reference slot of its kind declaring 'callsCoReferrers'"),
      }),
    );
  }, 60_000);

  /** An application announcing `Joined` to the listeners named, rewritten in
   *  place for a reconcile. */
  async function reconcilable(): Promise<(listeners: string[]) => Promise<string>> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-co-referrers-")));
    dirs.push(dir);
    const appPath = path.join(dir, "telo.yaml");
    const listener = (name: string) =>
      `---\nkind: Co.Listener\nmetadata: { name: ${name} }\ntopic: !ref Joined\nlabel: ${name}\n`;
    return async (listeners) => {
      await fs.writeFile(
        appPath,
        `kind: Telo.Application\nmetadata: { name: CoReconcile }\n` +
          `imports: { Co: ${path.join(FIXTURES, "kinds")} }\n` +
          `---\nkind: Co.Topic\nmetadata: { name: Joined }\nschema: { type: object }\n` +
          `---\nkind: Co.Announce\nmetadata: { name: announce }\ntopic: !ref Joined\n` +
          listeners.map(listener).join(""),
      );
      return appPath;
    };
  }
  const announce = (kernel: Kernel) =>
    kernel.invoke<unknown, { ran: string[] }>({ kind: "Co.Announce", name: "announce" }, {});

  it("reaches a co-referrer a reconcile adds, without recreating the caller", async () => {
    const write = await reconcilable();
    const kernel = await boot(await write(["early"]));
    const root = rootOf(kernel) as unknown as { resourceInstances: Map<string, { instance: unknown }> };
    const announcer = root.resourceInstances.get("announce")!.instance;

    expect((await announce(kernel)).ran).toEqual(["early"]);
    await write(["early", "late"]);
    const outcome = await kernel.reconcile();
    expect(outcome.restartRequired).toBeUndefined();
    expect(outcome.reinitialized).toEqual(["late"]);
    expect(root.resourceInstances.get("announce")!.instance).toBe(announcer);
    expect((await announce(kernel)).ran).toEqual(["early", "late"]);
  }, 60_000);

  it("cancels a dispatch asking while a reconcile rebuilds the set", async () => {
    const write = await reconcilable();
    const kernel = await boot(await write(["early"]));
    let during: unknown;
    // Raised inside the reconcile, between the unwind and the re-index.
    kernel.on("*", async (event) => {
      if (event.name.endsWith(".late.Initialized")) during = await announce(kernel).catch((error) => error);
    });
    await write(["early", "late"]);
    await kernel.reconcile();
    expect(during).toMatchObject({
      code: "ERR_INVOKE_CANCELLED",
      message: expect.stringContaining("was cancelled: the runtime is reconciling"),
    });
    expect((await announce(kernel)).ran).toEqual(["early", "late"]);
  }, 60_000);
});

/**
 * A `Telo.Import` declared in a scope: its library instance is indexed for the
 * scope run alone, so its co-referrers run for that run's dispatches and are
 * gone when it unwinds.
 */
describe("a scoped import's co-referrers", () => {
  const runSequence = (kernel: Kernel, name: string) =>
    kernel.invoke<unknown, { ran: string[] }>({ kind: "Telo.Sequence", name }, {});

  it("dispatches exactly the co-referrers the call graph lists for the scoped instance", async () => {
    const kernel = await boot(path.join(FIXTURES, "scoped.yaml"));
    const graph = kernel.getLoadedGraph()!;
    const flattened = flattenForAnalyzer(graph);
    const registry = new AnalysisRegistry();
    const analyzer = new StaticAnalyzer();
    analyzer.analyze(flattened, { moduleDocuments: collectModuleDocuments(graph) }, registry);
    const manifests = analyzer.normalize(flattened, registry);
    const callGraph = (registry.analysisOf(manifests) as unknown as { callGraph: CallGraph }).callGraph;
    // Each scope's instance is its own: one copy of the library per holder.
    const nodeOf = (id: string) => callGraph.nodes.get(id) as ResourceGraphNode;
    const listed = callGraph.edges
      .filter((edge) => edge.coReferrer)
      .map((edge) => `${importPathOf(nodeOf(edge.from).manifest)!.join(".")} → ${nodeOf(edge.to!).name}`);

    expect((await runSequence(kernel, "first")).ran).toEqual(["one", "two"]);
    expect(listed).toEqual(["first.Inner → one", "first.Inner → two", "second.Inner → one", "second.Inner → two"]);
  }, 60_000);

  it("keeps two runs of a scope apart", async () => {
    const kernel = await boot(path.join(FIXTURES, "scoped.yaml"));
    const [first, second] = await Promise.all([runSequence(kernel, "first"), runSequence(kernel, "second")]);
    expect(first.ran).toEqual(["one", "two"]);
    expect(second.ran).toEqual(["one", "two"]);
    expect((await runSequence(kernel, "first")).ran).toEqual(["one", "two"]);
  }, 60_000);

  it("adds a shared library a scope run first instantiates to the application's co-referrers", async () => {
    const kernel = await boot(path.join(FIXTURES, "scoped-shared.yaml"));
    expect((await runSequence(kernel, "run")).ran).toEqual(["sharedOwn"]);
  }, 60_000);

  /** A scope holding one `Telo.Import` of `source`, run on the booted root. */
  const scopeOf = (kernel: Kernel, source: string) =>
    (
      kernel as unknown as {
        rootContext: {
          createScopeHandle(
            manifests: unknown[],
            holder: unknown,
            field: string,
          ): { run<T>(fn: (scope: { getInstance(name: string, alias?: string): unknown }) => Promise<T>): Promise<T> };
        };
      }
    ).rootContext.createScopeHandle(
      [{ kind: "Telo.Import", metadata: { name: "Inner", module: "CoScoped", source: path.join(FIXTURES, "scoped.yaml") }, source }],
      { kind: "Telo.Sequence", metadata: { name: "holder", module: "CoScoped" } },
      "with",
    );

  it("cancels a request for co-referrers once the scope run has unwound", async () => {
    const kernel = await boot(path.join(FIXTURES, "scoped.yaml"));
    const announcer = (await scopeOf(kernel, "./scoped-lib").run(async (scope) => scope.getInstance("announce", "Inner"))) as {
      coReferrersAt(slot: string): unknown;
    };
    expect(() => announcer.coReferrersAt("/topic")).toThrowError(
      expect.objectContaining({ code: "ERR_INVOKE_CANCELLED", message: expect.stringContaining("the scope run holding its target has ended") }),
    );
  }, 60_000);

  it("refuses a co-referrer whose target outlives the scoped instance", async () => {
    const kernel = await boot(path.join(FIXTURES, "scoped.yaml"));
    const failure = await scopeOf(kernel, "./scoped-outliving")
      .run(async () => undefined)
      .then(
        () => undefined,
        (error: unknown) => rootCause(error),
      );
    expect(failure).toEqual({
      code: "ERR_CO_REFERRER_SCOPED",
      message: expect.stringContaining(
        "Co.Listener 'onShared' names Shared.Joined at 'topic', which makes it a co-referrer that every " +
          "dispatch through a 'callsCoReferrers' slot naming Shared.Joined calls, but it is declared in the " +
          "library imported as 'Inner' in the `with:` scope of 'holder', which exists only while that scope " +
          "runs, while Shared.Joined outlives it; declare the handler in a module that lives as long as Shared.Joined.",
      ),
    });
  }, 60_000);
});

/**
 * The two refusals, each raised by the kernel itself: documents created in a
 * scope of a booted application, which no load-time analysis stands in front of.
 */
describe("the kernel's co-referrer refusals", () => {
  async function createInScope(
    manifests: Record<string, unknown>[],
    kernel?: Kernel,
  ): Promise<{ code?: string; message: string } | undefined> {
    kernel ??= await boot(path.join(FIXTURES, "guards.yaml"));
    const scope = (
      kernel as unknown as {
        rootContext: { createScopeHandle(manifests: unknown[]): { run(fn: () => Promise<void>): Promise<void> } };
      }
    ).rootContext.createScopeHandle(
      manifests.map((m) => ({ ...m, metadata: { ...(m.metadata as object), module: "CoGuards" } })),
    );
    try {
      await scope.run(async () => {});
      return undefined;
    } catch (error) {
      return rootCause(error);
    }
  }

  const shout = (slot: string) => ({
    kind: "Telo.Definition",
    metadata: { name: "Shout" },
    capability: "Telo.Type",
    schema: {
      type: "object",
      properties: {
        topic: { "x-telo-ref": { kind: "Co.Topic", use: "schema", callsCoReferrers: { kind: "Co.Listener", slot } } },
      },
    },
  });

  it("registers a kind whose callsCoReferrers names another module's kind and slot", async () => {
    expect(await createInScope([shout("/topic")])).toBeUndefined();
  }, 60_000);

  it("refuses a malformed callsCoReferrers when the kind registers", async () => {
    expect(await createInScope([shout("/label")])).toEqual({
      code: "ERR_X_TELO_REF_INVALID_CALLS_CO_REFERRERS",
      message: expect.stringContaining(
        "Telo.Definition 'Shout': x-telo-ref at 'schema.properties.topic' declares 'callsCoReferrers', " +
          "and 'CoKinds.Listener' declares no reference slot at '/label'.",
      ),
    });
  }, 60_000);

  it("reads the calls of a kind registered again under the same name", async () => {
    const kernel = await boot(path.join(FIXTURES, "guards.yaml"));
    const echo = (calls: boolean) => ({
      kind: "Telo.Definition",
      metadata: { name: "Echo" },
      capability: "Telo.Type",
      schema: {
        type: "object",
        properties: {
          topic: {
            "x-telo-ref": {
              kind: "Co.Topic",
              use: "schema",
              ...(calls ? { callsCoReferrers: { kind: "Self.Echo", slot: "/topic" } } : {}),
            },
          },
        },
      },
    });
    const holding = {
      kind: "Telo.Sequence",
      metadata: { name: "echoTest" },
      with: [
        {
          kind: "Self.Echo",
          metadata: { name: "scopedEcho" },
          topic: { __ref: true, kind: "Co.Topic", name: "Joined", indexes: [] },
        },
      ],
      steps: [],
    };
    expect(await createInScope([echo(false)], kernel)).toBeUndefined();
    expect(await createInScope([holding], kernel)).toBeUndefined();
    expect(await createInScope([echo(true)], kernel)).toBeUndefined();
    expect(await createInScope([holding], kernel)).toMatchObject({ code: "ERR_CO_REFERRER_SCOPED" });
  }, 60_000);

  it("refuses a co-referrer declared in an execution scope", async () => {
    const sequence = {
      kind: "Telo.Sequence",
      metadata: { name: "announceTest" },
      with: [
        {
          kind: "Co.Listener",
          metadata: { name: "captureJoined" },
          topic: { __ref: true, kind: "Co.Topic", name: "Joined", indexes: [] },
          label: "captured",
        },
      ],
      steps: [],
    };
    expect(await createInScope([sequence])).toEqual({
      code: "ERR_CO_REFERRER_SCOPED",
      message: expect.stringContaining(
        "Co.Listener 'captureJoined' names Joined at 'topic', which makes it a co-referrer that every " +
        "dispatch through a 'callsCoReferrers' slot naming Joined calls, but it is declared in the " +
        "`with:` scope of 'announceTest', so it exists only while that scope runs and no such dispatch " +
        "can reach it; declare it at module scope.",
      ),
    });
  }, 60_000);
});

type Failure = { code?: string; message: string; diagnostics?: Failure[]; children?: Failure[]; derived?: boolean };

function rootCause(error: unknown): { code?: string; message: string } {
  const failure = error as Failure;
  const nested = [...(failure.diagnostics ?? []), ...(failure.children ?? [])].filter((d) => !d.derived);
  return nested.length > 0 ? rootCause(nested[0]) : { code: failure.code, message: failure.message };
}
