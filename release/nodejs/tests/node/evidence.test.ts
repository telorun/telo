import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_LEDGER, SHIPPED_ADAPTERS } from "../../src/index.js";
import { declaredPayload } from "../../src/node/declared-payload.js";
import { cargoEvidence } from "../../src/node/adapters/cargo-evidence.js";
import { dockerEvidence } from "../../src/node/adapters/docker-evidence.js";
import { helmEvidence } from "../../src/node/adapters/helm-evidence.js";
import type { EvidenceAdapter } from "../../src/node/evidence.js";
import { loadReleaseWorkspace } from "../../src/node/workspace.js";
import { has, host, run, tempRepo, write } from "./fixture.js";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
  vi.unstubAllGlobals();
});

function repo(files: Record<string, string>): string {
  const root = tempRepo(files);
  roots.push(root);
  return root;
}

async function collect(root: string, adapter: EvidenceAdapter, key: string, index = 0) {
  const workspace = loadReleaseWorkspace(root, { adapters: SHIPPED_ADAPTERS });
  const unit = workspace.units.find((u) => u.key === key)!;
  const anchor = unit.anchors.filter((a) => a.ecosystem === adapter.ecosystem)[index]!;
  const session = await adapter.open(workspace, { ledger: EMPTY_LEDGER, argv: {} });
  return { found: await session.collect({ unit, anchor }), destination: session.destination?.({ unit, anchor }), session, unit, anchor };
}

describe("docker evidence", () => {
  const files = {
    "telo-workspace.yaml": [
      "release:",
      "  ecosystems: { docker: { registry: ghcr.io/acme } }",
      "  units:",
      "    - path: app",
      "      version: VERSION",
      "      ecosystem: { docker: { '.': {}, worker: { context: ., name: app-worker } } }",
    ].join("\n"),
    "app/VERSION": "1.0.0\n",
    "app/Dockerfile": "FROM scratch\n",
    "app/Dockerfile.dockerignore": "Dockerfile*\nsecret.txt\n",
    "app/index.js": "1\n",
    "app/secret.txt": "s\n",
    "app/worker/Dockerfile": "FROM scratch\n",
    "lib/package.json": '{ "name": "lib", "version": "1.0.0" }\n',
  };

  it("gives each anchor its own context, layer and destination", async () => {
    const root = repo(files);
    const own = await collect(root, dockerEvidence, "app", 0);
    const worker = await collect(root, dockerEvidence, "app", 1);
    expect(own.destination).toBe("ghcr.io/acme/app");
    expect(worker.destination).toBe("ghcr.io/acme/app-worker");
    expect(own.found.files).toEqual([
      "app/Dockerfile",
      "app/Dockerfile.dockerignore",
      "app/VERSION",
      "app/index.js",
      "app/worker/Dockerfile",
    ]);
    // The worker's context is the workspace root, with no ignore file there.
    expect(worker.found.files).toEqual(expect.arrayContaining(["lib/package.json", "app/worker/Dockerfile", "telo-workspace.yaml"]));
    expect(own.found.layer).not.toBe(worker.found.layer);

    const { host: h, recorded } = host();
    const order = await run(h, recorded, root, ["order"]);
    expect((order.payload.order as { path: string; destination: string }[]).map((r) => [r.path, r.destination])).toEqual([
      ["app", "ghcr.io/acme/app"],
      ["app/worker", "ghcr.io/acme/app-worker"],
    ]);
  });

  it("moves when the Dockerfile its own ignore file excludes is edited", async () => {
    const root = repo(files);
    const before = (await collect(root, dockerEvidence, "app")).found.layer;
    write(root, { "app/secret.txt": "changed\n" });
    expect((await collect(root, dockerEvidence, "app")).found.layer).toBe(before);
    write(root, { "app/Dockerfile": "FROM scratch\nCMD [\"x\"]\n" });
    expect((await collect(root, dockerEvidence, "app")).found.layer).not.toBe(before);
  });

  it("refuses an anchor with no registry, and a context that is no directory", async () => {
    const root = repo({
      "telo-workspace.yaml":
        "release:\n  units:\n    - { path: a, version: V, ecosystem: docker }\n    - path: b\n      version: V\n      ecosystem: { docker: { '.': { context: nowhere, registry: r } } }\n",
      "a/V": "1.0.0\n",
      "a/Dockerfile": "FROM scratch\n",
      "b/V": "1.0.0\n",
      "b/Dockerfile": "FROM scratch\n",
    });
    const { host: h, recorded } = host();
    const check = await run(h, recorded, root, ["check", "--base", "HEAD"]);
    expect(check.exitCode).toBe(1);
    expect((check.payload.diagnostics as { code: string }[]).map((d) => d.code).sort()).toEqual([
      "NO_DESTINATION_KNOWN",
      "WORKSPACE_ANCHOR_INVALID",
    ]);
  });
});

describe("a declared { command } payload", () => {
  const unitWith = (command: string) =>
    loadReleaseWorkspace(
      repo({
        "telo-workspace.yaml": `release:\n  units:\n    - path: ext\n      version: VERSION\n      payload: { command: "${command}" }\n`,
        "ext/VERSION": "1.0.0\n",
        "ext/a.txt": "a\n",
      }),
      { adapters: SHIPPED_ADAPTERS },
    );
  const digest = (command: string) => {
    const workspace = unitWith(command);
    return declaredPayload(workspace.root, workspace.units[0]!);
  };

  it("digests the files it prints", () => {
    expect(digest("echo a.txt").files).toEqual(["ext/a.txt"]);
  });
  it("refuses a non-zero exit, a missing file, a duplicate and a path outside the workspace", () => {
    expect(() => digest("exit 3")).toThrow(/exited 3/);
    expect(() => digest("echo b.txt")).toThrow(/names no file/);
    expect(() => digest("echo a.txt; echo a.txt")).toThrow(/twice/);
    expect(() => digest("echo ../../etc/passwd")).toThrow(/outside the workspace/);
  });
});

describe.skipIf(!has("cargo"))("cargo evidence", () => {
  it("lists the packaged files and takes path dependencies as edges, never dev ones", async () => {
    const root = repo({
      "telo-workspace.yaml": "release:\n  units:\n    - { path: core, ecosystem: cargo }\n    - { path: app, ecosystem: cargo }\n    - { path: dev, ecosystem: cargo }\n",
      "Cargo.toml": '[workspace]\nmembers = ["core", "app", "dev"]\nresolver = "2"\n',
      "core/Cargo.toml": '[package]\nname = "fx-core"\nversion = "1.0.0"\nedition = "2021"\nlicense = "MIT"\ndescription = "x"\n',
      "core/src/lib.rs": "pub fn f() {}\n",
      "dev/Cargo.toml": '[package]\nname = "fx-dev"\nversion = "1.0.0"\nedition = "2021"\n',
      "dev/src/lib.rs": "\n",
      "app/Cargo.toml":
        '[package]\nname = "fx-app"\nversion = "1.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\nfx-core = { path = "../core", version = "1.0.0" }\n\n[dev-dependencies]\nfx-dev = { path = "../dev" }\n',
      "app/src/lib.rs": "\n",
    });
    const app = await collect(root, cargoEvidence, "app");
    expect(app.found.imports).toEqual(["core"]);
    const core = await collect(root, cargoEvidence, "core");
    expect(core.found.files).toEqual(expect.arrayContaining(["core/Cargo.toml", "core/src/lib.rs"]));
    expect(await app.session.readBack!({ unit: app.unit, anchor: app.anchor }, "1.0.0", undefined)).toMatchObject({ kind: "unverifiable" });
  }, 120_000);

  it("reads a license file the manifest names outside the crate, where it is", async () => {
    const root = repo({
      "telo-workspace.yaml": "release:\n  units:\n    - { path: lic, ecosystem: cargo }\n",
      LICENSE: "MIT\n",
      "lic/Cargo.toml": '[package]\nname = "fx-lic"\nversion = "1.0.0"\nedition = "2021"\nlicense-file = "../LICENSE"\n\n[workspace]\n',
      "lic/src/lib.rs": "\n",
    });
    const lic = await collect(root, cargoEvidence, "lic");
    expect(lic.found.files).toEqual(expect.arrayContaining(["LICENSE", "lic/Cargo.toml"]));
  }, 120_000);

  /** A workspace whose binary `app` links `core`'s closure, over a vendored registry so the offline resolve needs nothing fetched. */
  function linkingWorkspace(publishable: boolean) {
    const checksum = (name: string, version: string) => createHash("sha256").update(`${name}@${version}`).digest("hex");
    const crate = (name: string, version: string, body = "") => ({
      [`vendor/${name}-${version}/Cargo.toml`]: `[package]\nname = "${name}"\nversion = "${version}"\nedition = "2021"\n${body}`,
      [`vendor/${name}-${version}/src/lib.rs`]: "\n",
      [`vendor/${name}-${version}/.cargo-checksum.json`]: JSON.stringify({ files: {}, package: checksum(name, version) }),
    });
    const lock = (gui: string, dev: string, leaf: string) =>
      [
        "version = 4",
        '[[package]]\nname = "fx-app"\nversion = "1.0.0"\ndependencies = [\n "fx-core",\n "fx-dev",\n "fx-gui",\n]',
        '[[package]]\nname = "fx-core"\nversion = "1.0.0"\ndependencies = [\n "fx-leaf",\n]',
        ...(
          [
            ["fx-dev", dev],
            ["fx-gui", gui],
            ["fx-leaf", leaf],
          ] as const
        ).map(
          ([name, version]) =>
            `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${checksum(name, version)}"`,
        ),
      ].join("\n\n") + "\n";
    const publish = publishable ? 'license = "MIT"\ndescription = "x"\n' : "publish = false\n";
    const root = repo({
      ...Object.assign({}, ...["fx-gui", "fx-dev", "fx-leaf"].flatMap((name) => ["1.0.0", "1.0.1"].map((version) => crate(name, version)))),
      // What `cargo package` resolves the packaged manifest's `fx-core` against.
      ...crate("fx-core", "1.0.0", '\n[dependencies]\nfx-leaf = "1"\n'),
      "telo-workspace.yaml": "release:\n  units:\n    - { path: core, ecosystem: cargo }\n    - { path: app, ecosystem: cargo }\n",
      ".cargo/config.toml": '[source.crates-io]\nreplace-with = "vendored"\n\n[source.vendored]\ndirectory = "vendor"\n',
      "Cargo.toml": '[workspace]\nmembers = ["core", "app"]\nresolver = "2"\n',
      "Cargo.lock": lock("1.0.1", "1.0.1", "1.0.1"),
      "core/Cargo.toml": '[package]\nname = "fx-core"\nversion = "1.0.0"\nedition = "2021"\npublish = false\n\n[dependencies]\nfx-leaf = "1"\n',
      "core/src/lib.rs": "\n",
      "app/Cargo.toml":
        `[package]\nname = "fx-app"\nversion = "1.0.0"\nedition = "2021"\n${publish}\n[features]\ngui = ["dep:fx-gui"]\n\n` +
        '[dependencies]\nfx-core = { path = "../core", version = "1.0.0" }\nfx-gui = { version = "1", optional = true }\n\n[dev-dependencies]\nfx-dev = "1"\n',
      "app/src/main.rs": "fn main() {}\n",
    });
    return { root, lock };
  }

  it("moves a binary's layer with a lockfile-only bump of what it links, never with a dev dependency, and never a library's", async () => {
    const { root, lock } = linkingWorkspace(false);
    const layers = async () => ({
      app: (await collect(root, cargoEvidence, "app")).found.layer,
      core: (await collect(root, cargoEvidence, "core")).found.layer,
    });
    const at = async (gui: string, dev: string, leaf: string) => {
      write(root, { "Cargo.lock": lock(gui, dev, leaf) });
      return layers();
    };

    const first = await layers();
    expect(await layers()).toEqual(first);
    const gui = await at("1.0.0", "1.0.1", "1.0.1");
    expect(gui.app).not.toBe(first.app);
    expect(gui.core).toBe(first.core);
    expect(await at("1.0.0", "1.0.0", "1.0.1")).toEqual(gui);
    const leaf = await at("1.0.0", "1.0.0", "1.0.0");
    expect(leaf.app).not.toBe(gui.app);
    expect(leaf.core).toBe(first.core);
  }, 120_000);

  it("reads a published binary crate back to the layer its tree gives", async () => {
    const { root } = linkingWorkspace(true);
    execFileSync("cargo", ["package", "--offline", "--no-verify", "--allow-dirty", "--registry", "crates-io", "-p", "fx-app"], { cwd: root, stdio: "pipe" });
    const crate = fs.readFileSync(`${root}/target/package/fx-app-1.0.0.crate`);
    vi.stubGlobal("fetch", async (url: string) =>
      url === "https://crates.io/api/v1/crates/fx-app/1.0.0"
        ? new Response("{}")
        : url === "https://crates.io/api/v1/crates/fx-app/1.0.0/download"
          ? new Response(crate)
          : new Response("", { status: 404 }),
    );
    const app = await collect(root, cargoEvidence, "app");
    const back = await app.session.readBack!({ unit: app.unit, anchor: app.anchor }, "1.0.0", app.found.layer);
    expect(back).toEqual({ kind: "published", layer: app.found.layer, drift: [] });
  }, 120_000);
});

describe.skipIf(!has("helm", ["version", "--short"]))("helm evidence", () => {
  it("digests what helm package builds and publishes under the chart's name", async () => {
    const root = repo({
      "telo-workspace.yaml":
        "release:\n  ecosystems: { helm: { registry: oci://registry.example/charts } }\n  units:\n    - { path: svc, ecosystem: { helm: chart } }\n",
      "svc/chart/Chart.yaml": "apiVersion: v2\nname: svc\nversion: 1.0.0\nappVersion: 1.0.0\n",
      "svc/chart/values.yaml": "a: 1\n",
      "svc/chart/notes.tmp": "x\n",
      "svc/chart/.helmignore": "*.tmp\n",
    });
    const chart = await collect(root, helmEvidence, "svc");
    expect(chart.destination).toBe("oci://registry.example/charts/svc");
    expect(chart.found.files).toEqual(expect.arrayContaining(["svc/chart/Chart.yaml", "svc/chart/values.yaml"]));
    expect(chart.found.files).not.toContain("svc/chart/notes.tmp");
  }, 60_000);
});

describe("npm evidence", () => {
  it("digests a packed manifest with its dependency maps in name order", async () => {
    const { canonicalManifest } = await import("../../src/node/adapters/npm-evidence.js");
    const manifest = (text: string) => [{ path: "package.json", content: Buffer.from(text) }];
    const one = canonicalManifest(manifest('{\n  "name": "a",\n  "dependencies": { "b": "1.0.0", "a": "2.0.0" }\n}\n'));
    const two = canonicalManifest(manifest('{"name":"a","dependencies":{"a":"2.0.0","b":"1.0.0"}}'));
    expect(one).toEqual(two);
    // The same bytes the Rust half writes (`tests/commands.rs`).
    expect(Buffer.from((one[0] as { content: Uint8Array }).content).toString()).toBe('{"name":"a","dependencies":{"a":"2.0.0","b":"1.0.0"}}');
  });
});

describe("verify, per layer", () => {
  it("re-records an npm layer from the registry and keeps an unverifiable docker layer", async () => {
    const root = repo({
      "telo-workspace.yaml":
        "release:\n  ecosystems: { docker: { registry: ghcr.io/acme } }\n  units:\n    - { path: svc, ecosystem: [npm, docker] }\n",
      "package-lock.json": "{}\n",
      "svc/package.json": '{ "name": "svc", "version": "1.0.0" }\n',
      "svc/Dockerfile": "FROM scratch\n",
      ".changes/ledger.yaml": "units:\n  svc:\n    version: 1.0.0\n    layers:\n      docker: { .: sha256-docker }\n      npm: { .: sha256-stale }\n",
    });
    const { tarball, integrity } = await npmTarball({ "package/package.json": '{ "name": "svc", "version": "1.0.0" }\n' });
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("/svc/1.0.0")
        ? new Response(JSON.stringify({ dist: { tarball: "https://registry.example/svc.tgz", integrity } }))
        : url === "https://registry.example/svc.tgz"
          ? new Response(tarball)
          : new Response("", { status: 404 }),
    );
    const { host: h, recorded } = host();
    const verify = await run(h, recorded, root, ["verify"]);
    expect(verify.exitCode).toBe(1);
    expect(recorded.stderr.join("\n")).toMatch(/drift {2}svc npm\/\./);
    expect(recorded.stderr.join("\n")).toMatch(/unverifiable {2}svc docker\/\./);
    await run(h, recorded, root, ["verify", "--write"]);
    const ledger = fs.readFileSync(`${root}/.changes/ledger.yaml`, "utf8");
    expect(ledger).toContain("sha256-docker");
    expect(ledger).not.toContain("sha256-stale");
  });
});

async function npmTarball(files: Record<string, string>): Promise<{ tarball: Uint8Array; integrity: string }> {
  const { gzipSync } = await import("node:zlib");
  const { createHash } = await import("node:crypto");
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write("0000644\0", 100);
    header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("0", 156);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const tarball = gzipSync(Buffer.concat(blocks));
  return { tarball, integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}` };
}
