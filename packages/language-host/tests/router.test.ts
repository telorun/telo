import { afterEach, describe, expect, it, vi } from "vitest";
import { sha512Integrity } from "../src/engine-archive.js";
import { engineCode, fakeRegistry } from "./registry-fixture.js";
import { BUNDLED, RouterHarness, requirementsFor, type HarnessOptions } from "./router-harness.js";

const OWNER = "file:///ws/app/telo.yaml";
const PARTIAL = "file:///ws/app/routes.yaml";
const LIB = "file:///ws/lib/telo.yaml";
const LONE = "file:///ws/scratch.yaml";

/** A harness whose registry offers 0.103.0 and whose app module requires
 *  `>=min`, initialized with the registry read settled. */
async function appRequiring(min: string, options: HarnessOptions = {}, client = {}) {
  const registry = await fakeRegistry(["0.103.0"]);
  const harness = new RouterHarness({ fetch: registry.fetch, ...options });
  harness.requirements.set(OWNER, requirementsFor(OWNER, [OWNER, PARTIAL], [{ module: OWNER, text: `>=${min}`, min }]));
  await harness.initialize(client);
  await harness.router.markVersions();
  return { harness, registry };
}

const onEngine = (harness: RouterHarness, version: string, uri: string) =>
  harness.until(() => harness.engine(version)?.opened().includes(uri) === true, `${uri} on ${version}`);

afterEach(() => {
  vi.useRealTimers();
});

describe("the language router", () => {
  it("sends a document no module has claimed to the bundled engine", async () => {
    const harness = new RouterHarness();
    await harness.initialize();
    harness.open(LONE);
    const hover = await harness.client.sendRequest("textDocument/hover", {
      textDocument: { uri: LONE },
      position: { line: 0, character: 0 },
    });
    expect(hover).toEqual({ contents: `engine ${BUNDLED}` });
    expect(harness.engine(BUNDLED)!.opened()).toEqual([LONE]);
  });

  // The owner starts on the bundled engine, whose requirements resolve it to
  // 0.103.0; the owner moves once, and a member opened later goes straight there.
  it("routes every document an owner claims to the engine its requirements resolve to", async () => {
    const { harness } = await appRequiring("0.103.0");
    harness.open(OWNER);
    await onEngine(harness, "0.103.0", OWNER);
    harness.open(PARTIAL);
    await onEngine(harness, "0.103.0", PARTIAL);
    expect(harness.engine(BUNDLED)!.opened()).toEqual([]);
    expect(harness.engine("0.103.0")!.opened()).toEqual([OWNER, PARTIAL]);
  });

  // The editor and an engine may spell one location differently (Monaco
  // encodes parentheses, an engine need not); identity is the canonical form.
  it("routes and shows diagnostics across spellings of one location", async () => {
    const editor = "file:///ws/My%20Project%20%28copy%29/app/telo.yaml";
    const engine = "file:///ws/My%20Project%20(copy)/app/telo.yaml";
    const editorPartial = "file:///ws/My%20Project%20%28copy%29/app/routes.yaml";
    const registry = await fakeRegistry(["0.103.0"]);
    const harness = new RouterHarness({ fetch: registry.fetch });
    harness.requirements.set(
      editor,
      requirementsFor(engine, [engine, "file:///ws/My%20Project%20(copy)/app/routes.yaml"], [
        { module: engine, text: ">=0.103.0", min: "0.103.0" },
      ]),
    );
    await harness.initialize();
    await harness.router.markVersions();
    harness.open(editor);
    await onEngine(harness, "0.103.0", editor);
    harness.open(editorPartial);
    await onEngine(harness, "0.103.0", editorPartial);
    harness.engine("0.103.0")!.publish(engine, "from the owner's engine");
    await harness.until(() => harness.diagnostics.get(editor)?.[0] === "from the owner's engine", "the diagnostics");
    expect(harness.engine(BUNDLED)!.opened()).toEqual([]);
  });

  it("forwards an engine's workspace/applyEdit to the editor and returns its answer", async () => {
    const harness = new RouterHarness({
      capabilities: { [BUNDLED]: { textDocumentSync: 1, executeCommandProvider: { commands: ["telo.upgradeImport"] } } },
    });
    await harness.initialize();
    harness.open(LONE);
    const result = await harness.client.sendRequest("workspace/executeCommand", {
      command: "telo.upgradeImport",
      arguments: [{ uri: LONE, aliases: ["Lib"] }],
    });
    expect(result).toEqual({ applied: true });
    expect(harness.applied).toEqual([{ edit: { changes: {} } }]);
  });

  it("answers an engine's non-file telo/read through the host's remote reader", async () => {
    const harness = new RouterHarness({ remote: async (uri) => ({ uri, text: `text of ${uri}` }) });
    await harness.initialize();
    harness.open(LONE);
    const read = await harness.client.sendRequest("telo/test/read", {
      textDocument: { uri: LONE },
      uri: "oci://registry.test/lib@1.0.0",
    });
    expect(read).toEqual({ uri: "oci://registry.test/lib@1.0.0", text: "text of oci://registry.test/lib@1.0.0" });
  });

  describe("diagnostics", () => {
    it("shows an open or claimed file only its serving engine's publication", async () => {
      const { harness } = await appRequiring("0.103.0");
      harness.open(OWNER);
      await harness.until(() => harness.diagnostics.get(OWNER)?.[0] === "from 0.103.0", "0.103.0's diagnostics");
      harness.engine(BUNDLED)!.publish(OWNER, "stale, from the engine the module left");
      harness.engine(BUNDLED)!.publish(PARTIAL, "stale partial");
      harness.engine("0.103.0")!.publish(PARTIAL, "partial from 0.103.0");
      await harness.until(() => harness.diagnostics.has(PARTIAL), "the partial's diagnostics");
      await new Promise((r) => setTimeout(r, 30));
      expect(harness.diagnostics.get(OWNER)).toEqual(["from 0.103.0"]);
      expect(harness.diagnostics.get(PARTIAL)).toEqual(["partial from 0.103.0"]);
    });

    // An imported library is no module's member: what the engine analysing the
    // app says about it is shown, whichever engine that is.
    it("shows any other file the union of what the running engines publish", async () => {
      const { harness } = await appRequiring("0.103.0");
      harness.open(OWNER);
      await onEngine(harness, "0.103.0", OWNER);
      harness.engine("0.103.0")!.publish(LIB, "unknown variable 'nmae'");
      await harness.until(() => harness.diagnostics.has(LIB), "the library's diagnostics");
      expect(harness.diagnostics.get(LIB)).toEqual(["unknown variable 'nmae'"]);

      harness.engine(BUNDLED)!.publish(LIB, "unknown variable 'nmae'", "deprecated kind");
      await harness.until(() => harness.diagnostics.get(LIB)?.length === 2, "the union");
      expect(harness.diagnostics.get(LIB)).toEqual(["unknown variable 'nmae'", "deprecated kind"]);
    });

    it("treats a file its owner no longer claims as any other file", async () => {
      const { harness } = await appRequiring("0.103.0");
      harness.open(OWNER);
      await onEngine(harness, "0.103.0", OWNER);
      harness.engine("0.103.0")!.send({
        method: "telo/requirements",
        params: requirementsFor(OWNER, [OWNER], [{ module: OWNER, text: ">=0.103.0", min: "0.103.0" }]),
      });
      await new Promise((r) => setTimeout(r, 20));
      harness.engine(BUNDLED)!.publish(PARTIAL, "from the bundled engine");
      harness.engine("0.103.0")!.publish(PARTIAL, "from 0.103.0");
      await harness.until(() => harness.diagnostics.get(PARTIAL)?.length === 2, "the union");
      expect(harness.diagnostics.get(PARTIAL)).toEqual(["from the bundled engine", "from 0.103.0"]);
    });

    it("shrinks that union when an engine withdraws its publication or stops", async () => {
      const { harness } = await appRequiring("0.103.0");
      harness.open(OWNER);
      await onEngine(harness, "0.103.0", OWNER);
      harness.engine(BUNDLED)!.publish(LIB, "from the bundled engine");
      harness.engine("0.103.0")!.publish(LIB, "from 0.103.0");
      await harness.until(() => harness.diagnostics.get(LIB)?.length === 2, "the union");

      harness.engine(BUNDLED)!.publish(LIB);
      await harness.until(() => harness.diagnostics.get(LIB)?.length === 1, "the withdrawal");
      expect(harness.diagnostics.get(LIB)).toEqual(["from 0.103.0"]);

      harness.close(OWNER);
      await harness.until(() => harness.diagnostics.get(LIB)?.length === 0, "the stopped engine's withdrawal");
    });
  });

  describe("status", () => {
    it("names the version and the range that chose it", async () => {
      const { harness } = await appRequiring("0.103.0");
      harness.router.setActiveDocument(OWNER);
      harness.open(OWNER);
      await harness.until(
        () => harness.router.status().version === "0.103.0" && !harness.router.status().starting,
        "the resolution",
      );
      expect(harness.router.status()).toEqual({
        document: OWNER,
        owner: OWNER,
        version: "0.103.0",
        pinned: false,
        starting: false,
        reason: { kind: "owner-range", range: ">=0.103.0" },
      });
    });

    it("reports a pin as pinned", async () => {
      const { harness } = await appRequiring("0.100.0", { pin: "0.103.0" });
      harness.router.setActiveDocument(OWNER);
      harness.open(OWNER);
      await onEngine(harness, "0.103.0", OWNER);
      expect(harness.router.status()).toMatchObject({ version: "0.103.0", pinned: true, reason: { kind: "pinned" } });
    });

    it("reports a version neither cached nor reachable, running nothing in its place", async () => {
      const { harness, registry } = await appRequiring("0.103.0");
      registry.offline = true;
      harness.router.setActiveDocument(OWNER);
      harness.open(OWNER);
      await harness.until(() => harness.router.status().error !== undefined, "the error state");
      expect(harness.router.status()).toMatchObject({ error: { kind: "offline-uncached", version: "0.103.0" } });
      expect(harness.router.status().version).toBeUndefined();
      expect(harness.engine(BUNDLED)!.opened()).toEqual([]);
    });

    it("reports a pin naming a version this editor does not offer", async () => {
      const { harness } = await appRequiring("0.100.0", { pin: "0.99.0" });
      harness.router.setActiveDocument(OWNER);
      harness.open(OWNER);
      await harness.until(() => harness.router.status().error !== undefined, "the error state");
      expect(harness.router.status().error).toMatchObject({ kind: "pin-unoffered", pin: "0.99.0", reason: "unpublished" });
      expect(harness.engine(BUNDLED)!.opened()).toEqual([]);
    });

    it("reports a closure no available telo satisfies, on the bundled engine", async () => {
      const { harness } = await appRequiring("0.200.0");
      harness.router.setActiveDocument(OWNER);
      harness.open(OWNER);
      await harness.until(() => harness.router.status().error !== undefined, "the error state");
      expect(harness.router.status()).toMatchObject({
        version: BUNDLED,
        error: { kind: "nothing-satisfies", ranges: [">=0.200.0"] },
      });
    });
  });

  describe("engine identity", () => {
    // A development build implementing the pending 0.102.0 names itself
    // 0.102.0+unreleased: a module forward-declaring >=0.102.0 is satisfied
    // by it, and it is never mistaken for a published 0.102.0.
    it("takes the bundled engine's identity from its handshake", async () => {
      const harness = new RouterHarness({ bundledCode: engineCode("0.102.0+unreleased") });
      harness.requirements.set(OWNER, requirementsFor(OWNER, [OWNER], [{ module: OWNER, text: ">=0.102.0", min: "0.102.0" }]));
      await harness.initialize();
      harness.router.setActiveDocument(OWNER);
      harness.open(OWNER);
      await harness.until(() => harness.router.status().reason?.kind === "owner-range", "the resolution");
      expect(harness.router.status()).toMatchObject({ version: "0.102.0+unreleased" });
      expect(harness.router.status().error).toBeUndefined();
      expect((await harness.router.markVersions()).versions).toEqual([
        { version: "0.102.0+unreleased", bundled: true, cached: true, accepted: true },
      ]);
    });

    it("refuses a downloaded engine whose handshake names another version", async () => {
      const registry = await fakeRegistry(["0.103.0"], {}, (v) => engineCode(v, "reports 0.104.0"));
      const harness = new RouterHarness({ fetch: registry.fetch, pin: "0.103.0" });
      await harness.initialize();
      await harness.router.markVersions();
      harness.router.setActiveDocument(OWNER);
      harness.open(OWNER);
      await harness.until(() => harness.router.status().error !== undefined, "the refusal");
      expect(harness.router.status().error).toMatchObject({ kind: "engine-refused", version: "0.103.0" });
      expect(harness.router.status().error!.message).toMatch(/downloaded as telo 0\.103\.0 but reports 0\.104\.0/);
      expect(harness.engine("0.103.0")!.terminated).toBe(true);
    });
  });

  describe("an engine that fails", () => {
    it("still answers initialize when the bundled engine throws while loading", async () => {
      const harness = new RouterHarness({ bundledCode: engineCode(BUNDLED, "throws") });
      const result = await harness.initialize();
      expect(result.capabilities).toEqual({ textDocumentSync: 1 });
      harness.router.setActiveDocument(LONE);
      harness.open(LONE);
      expect(harness.router.status()).toMatchObject({ starting: false, error: { kind: "engine-failed" } });
      expect(harness.router.status().error!.message).toMatch(/bundled telo engine failed: SyntaxError/);
      expect(harness.logs.some((m) => /bundled telo engine failed/.test(m))).toBe(true);
    });

    it("counts an engine that never answers initialize as failed after the bound", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      // Messages and real I/O (the download, its digest) keep flowing while
      // the clock stands still; it moves only when the test moves it.
      const turn = async () => {
        await vi.advanceTimersByTimeAsync(0);
        await new Promise((r) => setImmediate(r));
      };
      const until = async (predicate: () => boolean) => {
        for (let i = 0; i < 10_000 && !predicate(); i++) await turn();
      };
      const registry = await fakeRegistry(["0.103.0"], {}, (v) => engineCode(v, "silent"));
      const harness = new RouterHarness({ fetch: registry.fetch, pin: "0.103.0" });
      let initialized = false;
      void harness.initialize().then(() => (initialized = true));
      await until(() => initialized);
      harness.router.setActiveDocument(OWNER);
      harness.open(OWNER);
      await until(() => harness.engine("0.103.0")?.asked("initialize").length === 1);
      await vi.advanceTimersByTimeAsync(29_000);
      expect(harness.router.status().error).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      await until(() => harness.router.status().error !== undefined);
      expect(harness.router.status().error).toMatchObject({ kind: "engine-failed", version: "0.103.0" });
      expect(harness.router.status().error!.message).toMatch(/did not answer initialize within 30 s/);
    });

    it("rejects what was pending when a running engine dies, and Retry starts it again", async () => {
      const harness = new RouterHarness({ bundledCode: engineCode(BUNDLED, "hangs on hover") });
      await harness.initialize();
      harness.router.setActiveDocument(LONE);
      harness.open(LONE);
      await onEngine(harness, BUNDLED, LONE);
      const hover = harness.client.sendRequest("textDocument/hover", {
        textDocument: { uri: LONE },
        position: { line: 0, character: 0 },
      });
      await harness.until(() => harness.engine(BUNDLED)!.asked("textDocument/hover").length === 1, "the hover");
      harness.engine(BUNDLED)!.fail("the worker exited with code 1");
      await expect(hover).rejects.toThrow("the bundled telo 0.102.0 engine failed: the worker exited with code 1");
      await harness.until(() => harness.router.status().error?.kind === "engine-failed", "the error state");

      await harness.router.retry();
      await harness.until(() => harness.engines.length === 2 && harness.engines[1]!.opened().includes(LONE), "the restart");
      expect(harness.router.status()).toMatchObject({ version: BUNDLED, starting: false });
      expect(harness.router.status().error).toBeUndefined();
    });
  });

  describe("an engine that fails at the edge of its handshake", () => {
    it("counts an engine dying while initialized is sent as failed, and Retry starts it again", async () => {
      const harness = new RouterHarness({ bundledCode: engineCode(BUNDLED, "dies at initialized") });
      await harness.initialize();
      harness.router.setActiveDocument(LONE);
      expect(harness.router.status()).toMatchObject({ starting: false, error: { kind: "engine-failed", version: BUNDLED } });
      harness.open(LONE);
      await new Promise((r) => setTimeout(r, 20));
      expect(harness.engine(BUNDLED)!.opened()).toEqual([]);

      harness.bundledCode = engineCode(BUNDLED);
      await harness.router.retry();
      await harness.until(() => harness.engines[1]?.opened().includes(LONE) === true, "the restart");
      expect(harness.router.status().error).toBeUndefined();
    });

    // A module whose requirements named the bundled engine by its identity keeps
    // that identity; a restarted bundled engine that fails before its handshake
    // is still that engine, never a published one of the same number.
    it("never downloads the bundled engine's identity when a restarted bundled engine fails", async () => {
      const registry = await fakeRegistry([BUNDLED]);
      const harness = new RouterHarness({ fetch: registry.fetch, bundledCode: engineCode(BUNDLED, "hangs on hover") });
      harness.requirements.set(OWNER, requirementsFor(OWNER, [OWNER], []));
      await harness.initialize();
      await harness.router.markVersions();
      harness.router.setActiveDocument(OWNER);
      harness.open(OWNER);
      await harness.until(() => harness.router.status().reason?.kind === "bundled", "the owner's resolution");
      harness.engine(BUNDLED)!.fail("the worker exited with code 1");
      await harness.until(() => harness.router.status().error?.kind === "engine-failed", "the failure");

      harness.bundledCode = engineCode(BUNDLED, "throws");
      // A document opening while the bundled engine restarts routes the owner
      // again, before the restarted engine has named itself.
      const retried = harness.router.retry();
      harness.open(LONE);
      await retried;
      await harness.until(() => harness.engines.length === 2, "the restart");
      await new Promise((r) => setTimeout(r, 20));
      expect(harness.spawns).toEqual([undefined, undefined]);
      expect(harness.router.status().error).toMatchObject({ kind: "engine-failed", version: BUNDLED });
    });
  });

  describe("initialize", () => {
    it("is answered without waiting for the registry", async () => {
      const registry = await fakeRegistry(["0.103.0"]);
      registry.documentServed = new Promise(() => undefined);
      const harness = new RouterHarness({ fetch: registry.fetch });
      await harness.initialize();
      harness.open(LONE);
      const hover = await harness.client.sendRequest("textDocument/hover", {
        textDocument: { uri: LONE },
        position: { line: 0, character: 0 },
      });
      expect(hover).toEqual({ contents: `engine ${BUNDLED}` });
    });

    it("chooses again for every owner when the registry's catalog arrives", async () => {
      let serve!: () => void;
      const registry = await fakeRegistry(["0.103.0"]);
      registry.documentServed = new Promise((resolve) => (serve = resolve));
      const harness = new RouterHarness({ fetch: registry.fetch, catalog: { offered: [], unoffered: {} } });
      harness.requirements.set(OWNER, requirementsFor(OWNER, [OWNER], [{ module: OWNER, text: ">=0.103.0", min: "0.103.0" }]));
      await harness.initialize();
      harness.router.setActiveDocument(OWNER);
      harness.open(OWNER);
      await harness.until(() => harness.router.status().error?.kind === "nothing-satisfies", "rule 3 on the cached catalog");

      serve();
      await onEngine(harness, "0.103.0", OWNER);
      expect(harness.router.status()).toMatchObject({ version: "0.103.0", reason: { kind: "owner-range" } });
    });

    it("lets only a download wait for the registry", async () => {
      let serve!: () => void;
      const registry = await fakeRegistry(["0.103.0"]);
      registry.documentServed = new Promise((resolve) => (serve = resolve));
      const harness = new RouterHarness({ fetch: registry.fetch, pin: "0.103.0", catalog: { offered: [], unoffered: {} } });
      await harness.initialize();
      harness.router.setActiveDocument(OWNER);
      harness.open(OWNER);
      await new Promise((r) => setTimeout(r, 20));
      expect(harness.router.status()).toMatchObject({ version: "0.103.0", starting: true });

      serve();
      await onEngine(harness, "0.103.0", OWNER);
      expect(harness.statuses.some((s) => s.error)).toBe(false);
    });
  });

  describe("editor registrations", () => {
    const DYNAMIC = {
      textDocument: {
        completion: { dynamicRegistration: true },
        hover: { dynamicRegistration: true },
        semanticTokens: { dynamicRegistration: true },
      },
      workspace: { executeCommand: { dynamicRegistration: true }, didChangeWatchedFiles: { dynamicRegistration: true } },
    };

    it("registers the union of the running engines' features, again when that changes", async () => {
      const { harness } = await appRequiring(
        "0.103.0",
        {
          capabilities: {
            [BUNDLED]: { completionProvider: { triggerCharacters: [":"] }, executeCommandProvider: { commands: ["telo.a"] } },
            "0.103.0": {
              completionProvider: { triggerCharacters: ["@"] },
              hoverProvider: true,
              executeCommandProvider: { commands: ["telo.b"] },
            },
          },
        },
        DYNAMIC,
      );
      harness.open(OWNER);
      await onEngine(harness, "0.103.0", OWNER);
      await harness.until(() => harness.registered("textDocument/hover").length === 1, "the union");
      expect(harness.registered("textDocument/completion")).toEqual([{ documentSelector: null, triggerCharacters: [":", "@"] }]);
      expect(harness.registered("workspace/executeCommand")).toEqual([{ commands: ["telo.a", "telo.b"] }]);

      harness.close(OWNER);
      await harness.until(
        () =>
          harness.registered("textDocument/hover").length === 0 &&
          harness.registered("textDocument/completion")[0]?.triggerCharacters.length === 1,
        "the withdrawal",
      );
      expect(harness.registered("textDocument/completion")).toEqual([{ documentSelector: null, triggerCharacters: [":"] }]);
      expect(harness.registered("workspace/executeCommand")).toEqual([{ commands: ["telo.a"] }]);
    });

    it("offers the bundled engine's options statically to an editor that cannot register them", async () => {
      const harness = new RouterHarness({
        capabilities: { [BUNDLED]: { completionProvider: { triggerCharacters: [":"] }, hoverProvider: true } },
      });
      const result = await harness.initialize();
      expect(result.capabilities).toEqual({
        textDocumentSync: 1,
        completionProvider: { triggerCharacters: [":"] },
        hoverProvider: {},
        experimental: { telo: { protocol: 1 } },
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(harness.registrations).toEqual([]);
    });

    it("answers a request the serving engine did not advertise with nothing, asking no engine", async () => {
      const harness = new RouterHarness({ capabilities: { [BUNDLED]: { textDocumentSync: 1 } } });
      await harness.initialize(DYNAMIC);
      harness.open(LONE);
      const hover = await harness.client.sendRequest("textDocument/hover", {
        textDocument: { uri: LONE },
        position: { line: 0, character: 0 },
      });
      expect(hover).toBeNull();
      expect(harness.engine(BUNDLED)!.asked("textDocument/hover")).toEqual([]);
    });

    it("sends a resolve back to the engine that produced the item", async () => {
      const { harness } = await appRequiring(
        "0.103.0",
        {
          capabilities: {
            [BUNDLED]: { completionProvider: {} },
            "0.103.0": { completionProvider: { resolveProvider: true } },
          },
        },
        DYNAMIC,
      );
      harness.handlers["textDocument/completion"] = (engine) => [{ label: `from ${engine.version}`, data: { n: 1 } }];
      harness.handlers["completionItem/resolve"] = (engine, item) => ({ ...item, detail: `resolved by ${engine.version}` });
      harness.open(OWNER);
      await onEngine(harness, "0.103.0", OWNER);
      const [item] = (await harness.client.sendRequest("textDocument/completion", {
        textDocument: { uri: OWNER },
        position: { line: 0, character: 0 },
      })) as any[];
      const resolved: any = await harness.client.sendRequest("completionItem/resolve", item);
      expect(resolved.detail).toBe("resolved by 0.103.0");
      expect(harness.engine("0.103.0")!.asked("completionItem/resolve")[0]!.params.data).toEqual({ n: 1 });
      expect(harness.engine(BUNDLED)!.asked("completionItem/resolve")).toEqual([]);
    });

    it("unions the token legends by name and remaps each engine's tokens into it", async () => {
      const { harness } = await appRequiring(
        "0.103.0",
        {
          capabilities: {
            [BUNDLED]: { semanticTokensProvider: { legend: { tokenTypes: ["keyword", "string"], tokenModifiers: [] }, full: true } },
            "0.103.0": {
              semanticTokensProvider: { legend: { tokenTypes: ["string", "number"], tokenModifiers: ["readonly"] }, full: true },
            },
          },
        },
        DYNAMIC,
      );
      // A `number` token, then a `string` token marked readonly.
      harness.handlers["textDocument/semanticTokens/full"] = () => ({ data: [0, 0, 2, 1, 0, 0, 4, 3, 0, 1] });
      harness.open(OWNER);
      await onEngine(harness, "0.103.0", OWNER);
      await harness.until(
        () => harness.registered("textDocument/semanticTokens")[0]?.legend.tokenTypes.length === 3,
        "the union legend",
      );
      expect(harness.registered("textDocument/semanticTokens")).toEqual([
        {
          documentSelector: null,
          legend: { tokenTypes: ["keyword", "string", "number"], tokenModifiers: ["readonly"] },
          full: true,
        },
      ]);
      const tokens = await harness.client.sendRequest("textDocument/semanticTokens/full", { textDocument: { uri: OWNER } });
      expect(tokens).toEqual({ data: [0, 0, 2, 2, 0, 0, 4, 3, 1, 1] });
    });

    it("registers each distinct watcher once and tells each engine only what its watchers match", async () => {
      const { harness } = await appRequiring("0.103.0", {}, DYNAMIC);
      const watch = (id: string, ...globs: string[]) => [
        { id, method: "workspace/didChangeWatchedFiles", registerOptions: { watchers: globs.map((globPattern) => ({ globPattern })) } },
      ];
      harness.registrationsOnOpen[BUNDLED] = watch("watch-bundled", "**/*.yaml");
      harness.registrationsOnOpen["0.103.0"] = watch("watch-0.103.0", "**/*.yaml", "**/*.json");
      harness.open(LONE);
      harness.open(OWNER);
      await onEngine(harness, "0.103.0", OWNER);
      await harness.until(() => harness.registered("workspace/didChangeWatchedFiles").length === 2, "the watchers");
      expect(harness.registered("workspace/didChangeWatchedFiles")).toEqual([
        { watchers: [{ globPattern: "**/*.yaml" }] },
        { watchers: [{ globPattern: "**/*.json" }] },
      ]);

      const yaml = { uri: "file:///ws/app/a.yaml", type: 2 };
      const json = { uri: "file:///ws/app/b.json", type: 2 };
      await harness.client.sendNotification("workspace/didChangeWatchedFiles", { changes: [yaml, json] });
      const heard = (version: string) => harness.engine(version)!.asked("workspace/didChangeWatchedFiles").map((m) => m.params.changes);
      await harness.until(() => heard("0.103.0").length === 1 && heard(BUNDLED).length === 1, "the changes");
      expect(heard(BUNDLED)).toEqual([[yaml]]);
      expect(heard("0.103.0")).toEqual([[yaml, json]]);

      harness.close(OWNER);
      await harness.until(() => harness.registered("workspace/didChangeWatchedFiles").length === 1, "the withdrawal");
    });

    it("passes on and withdraws a registration of a method it does not own", async () => {
      const { harness } = await appRequiring("0.103.0");
      harness.registrationsOnOpen["0.103.0"] = [{ id: "custom-0.103.0", method: "custom/feature" }];
      harness.open(OWNER);
      await harness.until(() => harness.registered("custom/feature").length === 1, "the registration");
      harness.close(OWNER);
      await harness.until(() => harness.registered("custom/feature").length === 0, "the withdrawal");
    });
  });

  describe("resolutions stored per workspace", () => {
    const stored = (version: string) => ({ owners: { [OWNER]: { version, documents: [OWNER, PARTIAL] } } });
    const cachedEngine = async (version: string, code = engineCode(version)) => {
      const bytes = new TextEncoder().encode(code);
      return { [version]: { bytes, digest: await sha512Integrity(new TextEncoder().encode(engineCode(version))) } };
    };

    it("reopens a document straight on the engine its owner last resolved to", async () => {
      const registry = await fakeRegistry(["0.103.0"]);
      const harness = new RouterHarness({
        fetch: registry.fetch,
        catalog: registry.catalog,
        resolutions: stored("0.103.0"),
        cached: await cachedEngine("0.103.0"),
      });
      await harness.initialize();
      harness.open(PARTIAL);
      await harness.until(() => harness.diagnostics.get(PARTIAL)?.[0] === "from 0.103.0", "0.103.0's diagnostics");
      expect(harness.engine(BUNDLED)!.received.some((m) => m.method === "textDocument/didOpen")).toBe(false);
      expect(harness.diagnostics.get(PARTIAL)).toEqual(["from 0.103.0"]);
    });

    it("drops an entry whose engine is not cached and starts the owner on the bundled engine", async () => {
      const registry = await fakeRegistry(["0.103.0"]);
      const harness = new RouterHarness({ fetch: registry.fetch, catalog: registry.catalog, resolutions: stored("0.103.0") });
      await harness.initialize();
      harness.open(PARTIAL);
      await onEngine(harness, BUNDLED, PARTIAL);
      expect(harness.engine("0.103.0")).toBeUndefined();
    });

    it("falls back to the bundled engine, logging why, when a stored engine is refused", async () => {
      const registry = await fakeRegistry(["0.103.0"]);
      registry.offline = true;
      const harness = new RouterHarness({
        fetch: registry.fetch,
        catalog: registry.catalog,
        resolutions: stored("0.103.0"),
        cached: await cachedEngine("0.103.0", "tampered"),
      });
      await harness.initialize();
      harness.router.setActiveDocument(PARTIAL);
      harness.open(PARTIAL);
      const logged = () =>
        harness.logs.some((m) => /telo 0\.103\.0 engine this workspace last used could not be loaded/.test(m));
      await harness.until(
        () => harness.engine(BUNDLED)!.opened().includes(PARTIAL) && logged(),
        "the fallback and its log line",
      );
      expect(harness.router.status()).toMatchObject({ version: BUNDLED });
      expect(harness.router.status().error).toBeUndefined();
    });

    it("writes nothing under a pin", async () => {
      const { harness } = await appRequiring("0.100.0", { pin: "0.103.0" });
      harness.open(OWNER);
      await onEngine(harness, "0.103.0", OWNER);
      await new Promise((r) => setTimeout(r, 20));
      expect(harness.resolutionWrites).toEqual([]);
    });
  });
});
