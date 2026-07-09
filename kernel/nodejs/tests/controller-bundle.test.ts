import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tryBuildControllerBundle } from "../src/controller-loaders/bundle-builder.js";

/**
 * Exercises the production bundling path — a *real* (copied) install — which the
 * integration suite can't cover because its monorepo controllers are symlinked
 * `local_path` deps that the loader deliberately skips (see the symlink test).
 */
describe("controller bundling", () => {
  let root: string;

  async function write(rel: string, contents: string): Promise<void> {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, contents);
  }

  beforeAll(async () => {
    // realpath so the gate's realpath comparison sees the entry under the root
    // (macOS tmpdir is a /var → /private/var symlink).
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-bundle-")));
    // A pure-JS third-party dep that must be inlined.
    await write("node_modules/leftpad/package.json", JSON.stringify({ name: "leftpad", version: "1.0.0", type: "module", main: "index.js" }));
    await write("node_modules/leftpad/index.js", `export const MARKER = "LEFTPAD_INLINED";`);
    // The realm package — must stay external and resolve to this copy at runtime.
    await write("node_modules/@telorun/sdk/package.json", JSON.stringify({ name: "@telorun/sdk", version: "1.0.0", type: "module", main: "index.js" }));
    await write("node_modules/@telorun/sdk/index.js", `export const SDK = "REAL_SDK";`);
    // The controller package, copied under the root (a real install).
    await write("node_modules/ctrl/package.json", JSON.stringify({ name: "ctrl", version: "1.0.0", type: "module", main: "index.js" }));
    await write(
      "node_modules/ctrl/index.js",
      `import { MARKER } from "leftpad";\nimport { SDK } from "@telorun/sdk";\nexport async function create() { return { marker: MARKER, sdk: SDK }; }`,
    );
    // A dep that locates a sibling asset relative to its own file — unsafe to
    // flatten into a bundle at a new location (the http-server `standalone.js`
    // failure mode). esbuild surfaces this as `import.meta.url` in the output.
    await write("node_modules/assetdep/package.json", JSON.stringify({ name: "assetdep", version: "1.0.0", type: "module", main: "index.js" }));
    await write("node_modules/assetdep/index.js", `import { fileURLToPath } from "url";\nexport const ASSET = fileURLToPath(new URL("./asset.txt", import.meta.url));`);
    await write("node_modules/ctrl-asset/package.json", JSON.stringify({ name: "ctrl-asset", version: "1.0.0", type: "module", main: "index.js" }));
    await write("node_modules/ctrl-asset/index.js", `import { ASSET } from "assetdep";\nexport function create() { return { asset: ASSET }; }`);
    // A CJS controller — no `type: module`, `module.exports`. esbuild bundles it
    // to `{ default }` only, so it must be skipped (the loose import synthesizes
    // the named `create`).
    await write("node_modules/cjsctrl/package.json", JSON.stringify({ name: "cjsctrl", version: "1.0.0", main: "index.js" }));
    await write("node_modules/cjsctrl/index.js", `module.exports = { create: async () => ({ ok: true }) };`);
    // A CJS dep that `require()`s a Node builtin — bundled into the ESM output as
    // esbuild's `__require("events")` shim, which throws "Dynamic require of
    // events is not supported" in a `.mjs` unless the bundle's banner defines
    // `require`. This is the tar-stream / yaml failure shape.
    await write("node_modules/cjsreq/package.json", JSON.stringify({ name: "cjsreq", version: "1.0.0", main: "index.js" }));
    await write(
      "node_modules/cjsreq/index.js",
      `const { EventEmitter } = require("events");\nmodule.exports = { ping: () => new EventEmitter() instanceof EventEmitter };`,
    );
    await write("node_modules/ctrl-cjsdep/package.json", JSON.stringify({ name: "ctrl-cjsdep", version: "1.0.0", type: "module", main: "index.js" }));
    await write("node_modules/ctrl-cjsdep/index.js", `import dep from "cjsreq";\nexport function create() { return { ok: dep.ping() }; }`);
    // A native dep (ships a `prebuilds/` dir) that must be externalized, not inlined.
    await write("node_modules/nativedep/package.json", JSON.stringify({ name: "nativedep", version: "1.0.0", type: "module", main: "index.js" }));
    await write("node_modules/nativedep/index.js", `export const NATIVE_MARKER = "NATIVE_INLINED";`);
    await write("node_modules/nativedep/prebuilds/.keep", "");
    await write("node_modules/ctrl-native/package.json", JSON.stringify({ name: "ctrl-native", version: "1.0.0", type: "module", main: "index.js" }));
    await write("node_modules/ctrl-native/index.js", `import { NATIVE_MARKER } from "nativedep";\nexport function create() { return { m: NATIVE_MARKER }; }`);
    // A package with TWO controller entries that share a relative module holding
    // a class. Each entry is bundled separately; inlining the shared module would
    // give each bundle its own copy of the class, so an instance made by one
    // controller would fail `instanceof` in the other. The shared module must
    // stay external + loose so both bundles resolve the same copy.
    await write("node_modules/sharedpkg/package.json", JSON.stringify({ name: "sharedpkg", version: "1.0.0", type: "module", exports: { "./a": "./a.js", "./b": "./b.js" } }));
    await write("node_modules/sharedpkg/store.js", `export class Store { constructor() { this.tag = "STORE_INTERNAL"; } }\nexport const make = () => new Store();\nexport const isStore = (v) => v instanceof Store;`);
    await write("node_modules/sharedpkg/a.js", `import { make } from "./store.js";\nexport function create() { return make(); }`);
    await write("node_modules/sharedpkg/b.js", `import { isStore } from "./store.js";\nexport function create() { return { isStore }; }`);
    // A dependency with its OWN internal relative import. When a controller pulls
    // it in, that internal `./inner.js` must stay INLINED with the dep (it's not
    // the controller package's shared module, and its path isn't relative to the
    // bundle) — externalizing it breaks any dependency that spreads across
    // internal relative modules.
    await write("node_modules/deprel/package.json", JSON.stringify({ name: "deprel", version: "1.0.0", type: "module", main: "index.js" }));
    await write("node_modules/deprel/inner.js", `export const INNER = "DEPREL_INNER";`);
    await write("node_modules/deprel/index.js", `import { INNER } from "./inner.js";\nexport const VALUE = INNER;`);
    await write("node_modules/ctrl-deprel/package.json", JSON.stringify({ name: "ctrl-deprel", version: "1.0.0", type: "module", main: "index.js" }));
    await write("node_modules/ctrl-deprel/index.js", `import { VALUE } from "deprel";\nexport function create() { return { value: VALUE }; }`);
    // Bundling is on by default — exercise that, not an explicit enable.
    delete process.env.TELO_CONTROLLER_BUNDLE;
  });

  afterAll(async () => {
    delete process.env.TELO_CONTROLLER_BUNDLE;
    await fs.rm(root, { recursive: true, force: true });
  });

  it("inlines third-party JS, keeps @telorun external, and runs", async () => {
    const entry = path.join(root, "node_modules/ctrl/index.js");
    const bundle = await tryBuildControllerBundle(root, entry);

    expect(bundle).toBeTruthy();
    // Beside the entry (so externals resolve through its node_modules walk-up).
    expect(bundle!.startsWith(path.dirname(entry) + path.sep)).toBe(true);

    const code = await fs.readFile(bundle!, "utf8");
    expect(code).toContain("LEFTPAD_INLINED"); // third-party JS inlined
    expect(code).toContain("@telorun/sdk"); // realm kept as an external bare import

    // The bundle imports and its external @telorun/sdk resolves to the copy under
    // the install root.
    const mod = await import(pathToFileURL(bundle!).href);
    const inst = await mod.create();
    expect(inst.marker).toBe("LEFTPAD_INLINED");
    expect(inst.sdk).toBe("REAL_SDK");
  });

  it("reuses the cached bundle on a second call", async () => {
    const entry = path.join(root, "node_modules/ctrl/index.js");
    const first = await tryBuildControllerBundle(root, entry);
    const second = await tryBuildControllerBundle(root, entry);
    expect(second).toBe(first);
  });

  it("skips a controller whose dep resolves assets relative to its own dir", async () => {
    // Would build, but flattening breaks the dep's `import.meta.url` asset path —
    // so it must fall back to the loose import, and write no bundle.
    const entry = path.join(root, "node_modules/ctrl-asset/index.js");
    expect(await tryBuildControllerBundle(root, entry)).toBeNull();
    const polluted = await fs
      .readdir(path.join(root, "node_modules/ctrl-asset"))
      .then((f) => f.filter((n) => n.startsWith(".telobundle")));
    expect(polluted).toEqual([]);
  });

  it("skips a CJS controller entry (esbuild can't lift its named exports)", async () => {
    const entry = path.join(root, "node_modules/cjsctrl/index.js");
    expect(await tryBuildControllerBundle(root, entry)).toBeNull();
  });

  it("lets a bundled CJS dep's require() of a builtin work (createRequire banner)", async () => {
    const entry = path.join(root, "node_modules/ctrl-cjsdep/index.js");
    const bundle = await tryBuildControllerBundle(root, entry);
    expect(bundle).toBeTruthy();
    const code = await fs.readFile(bundle!, "utf8");
    expect(code).toContain("createRequire"); // banner present
    // Without the banner this import throws "Dynamic require of "events" is not
    // supported" — the original tar-stream / yaml failure.
    const mod = await import(pathToFileURL(bundle!).href);
    expect((await mod.create()).ok).toBe(true);
  });

  it("externalizes native deps instead of inlining them", async () => {
    const entry = path.join(root, "node_modules/ctrl-native/index.js");
    const bundle = await tryBuildControllerBundle(root, entry);
    expect(bundle).toBeTruthy();
    const code = await fs.readFile(bundle!, "utf8");
    expect(code).not.toContain("NATIVE_INLINED"); // not inlined
    expect(code).toContain("nativedep"); // kept as an external import
  });

  it("keeps a package's own relative modules loose so its controllers share one class identity", async () => {
    const pkg = path.join(root, "node_modules/sharedpkg");
    const bundleA = await tryBuildControllerBundle(root, path.join(pkg, "a.js"));
    const bundleB = await tryBuildControllerBundle(root, path.join(pkg, "b.js"));
    expect(bundleA).toBeTruthy();
    expect(bundleB).toBeTruthy();

    // The shared relative module is NOT inlined into either bundle — each keeps
    // it as an external `./store.js` import that resolves to the one loose file.
    const codeA = await fs.readFile(bundleA!, "utf8");
    expect(codeA).not.toContain("STORE_INTERNAL");
    expect(codeA).toContain("./store.js");

    // Cross-controller identity: an instance created by controller `a` passes the
    // `instanceof` check inside controller `b`. Inlining would duplicate `Store`
    // and make this false — the exact JournalStore failure.
    const modA = await import(pathToFileURL(bundleA!).href);
    const modB = await import(pathToFileURL(bundleB!).href);
    const instance = await modA.create();
    const { isStore } = await modB.create();
    expect(isStore(instance)).toBe(true);
  });

  it("inlines a dependency's own internal relative imports (only the controller package's are externalized)", async () => {
    const entry = path.join(root, "node_modules/ctrl-deprel/index.js");
    const bundle = await tryBuildControllerBundle(root, entry);
    expect(bundle).toBeTruthy();
    const code = await fs.readFile(bundle!, "utf8");
    // The dep AND its internal module are inlined — not externalized to a loose
    // path that wouldn't resolve from the bundle's location.
    expect(code).toContain("DEPREL_INNER");
    expect(code).not.toMatch(/from\s+["']\.\.?\/.*inner/);
    // And it loads + runs.
    const mod = await import(pathToFileURL(bundle!).href);
    expect((await mod.create()).value).toBe("DEPREL_INNER");
  });

  it("is disabled by the TELO_CONTROLLER_BUNDLE=0 kill-switch", async () => {
    const entry = path.join(root, "node_modules/ctrl/index.js");
    process.env.TELO_CONTROLLER_BUNDLE = "0";
    try {
      expect(await tryBuildControllerBundle(root, entry)).toBeNull();
    } finally {
      delete process.env.TELO_CONTROLLER_BUNDLE;
    }
  });

  it("skips a symlinked (source-escaping) entry — never writes into the source tree", async () => {
    // A package whose source lives outside the install root, symlinked in (the
    // monorepo `local_path` shape). Bundling here would pollute the source dir.
    const src = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "telo-src-")));
    try {
      await fs.mkdir(path.join(src, "pkg"));
      await fs.writeFile(path.join(src, "pkg", "index.js"), `export function create() { return {}; }`);
      const linkParent = path.join(root, "node_modules", "linked");
      await fs.mkdir(linkParent, { recursive: true });
      await fs.symlink(path.join(src, "pkg"), path.join(linkParent, "pkg"), "dir");

      const entry = path.join(linkParent, "pkg", "index.js");
      const bundle = await tryBuildControllerBundle(root, entry);

      expect(bundle).toBeNull(); // skipped
      // No bundle was written into the real source dir.
      const polluted = await fs
        .readdir(path.join(src, "pkg"))
        .then((f) => f.filter((n) => n.startsWith(".telobundle")));
      expect(polluted).toEqual([]);
    } finally {
      await fs.rm(src, { recursive: true, force: true });
    }
  });
});
