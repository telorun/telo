import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkCrateInputs } from "../src/release/crate-inputs.js";
import { createArchiveReader, stageModule } from "../src/release/stage.js";
import type { DiscoveredModule } from "../src/release/workspace.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "telo-crate-inputs-"));
  // Two controller crates reach the ABI crate through the SDK — one by a plain
  // path, one through `[workspace.dependencies]` — and a third links neither.
  write("Cargo.toml", '[workspace]\nmembers = ["sdk/*", "modules/*/rust"]\n\n[workspace.dependencies]\nabi = { path = "sdk/abi" }\n');
  write("Cargo.lock", lockfile("bb"));
  write("README.md", "workspace\n");
  write("sdk/abi/Cargo.toml", '[package]\nname = "abi"\nversion = "0.0.0"\n');
  write("sdk/abi/src/lib.rs", "pub const ABI: u32 = 2;\n");
  write("sdk/rust/Cargo.toml", '[package]\nname = "sdk"\nversion = "0.0.0"\n\n[dependencies]\nabi.workspace = true\nserde_json = "1"\n');
  write("sdk/rust/src/lib.rs", "pub use abi::ABI;\n");
  for (const [name, dependency] of [
    ["alpha", 'sdk = { path = "../../../sdk/rust" }'],
    ["beta", '[dependencies.sdk]\npath = "../../../sdk/rust"'],
    ["gamma", 'serde_json = "1"'],
  ] as const) {
    write(
      `modules/${name}/rust/Cargo.toml`,
      `[package]\nname = "${name}"\nversion = "0.1.0"\ndescription = """\nA controller.\n"""\n\n` +
        `${dependency.startsWith("[") ? dependency : `[dependencies]\n${dependency}`}\n`,
    );
    write(`modules/${name}/rust/src/lib.rs`, `// ${name}\n`);
    write(
      `modules/${name}/telo.yaml`,
      [
        "kind: Telo.Library",
        "metadata:",
        `  name: ${name[0]!.toUpperCase()}${name.slice(1)}`,
        "  version: 0.1.0",
        "sources:",
        "  prebuilt:",
        "    version: 0.1.0",
        "    url: https://example.test/{version}/{upstream}.tar.gz",
        "    archive: tar.gz",
        "    notices: [./LICENSE]",
        "    build:",
        "      cargo: ./rust",
        "    entries: {}",
        "",
      ].join("\n"),
    );
  }
  commitAll();
});

function commitAll(): void {
  for (const args of [["init", "-q"], ["add", "-A"]]) {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  }
}

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A lockfile in cargo's shape; `unrelated` is a package no crate here reaches. */
function lockfile(unrelatedChecksum: string): string {
  const registry = 'source = "registry+https://github.com/rust-lang/crates.io-index"';
  return [
    "version = 3",
    "",
    '[[package]]\nname = "abi"\nversion = "0.0.0"',
    '[[package]]\nname = "alpha"\nversion = "0.1.0"\ndependencies = [\n "sdk",\n]',
    '[[package]]\nname = "beta"\nversion = "0.1.0"\ndependencies = [\n "sdk",\n]',
    '[[package]]\nname = "gamma"\nversion = "0.1.0"\ndependencies = [\n "serde_json",\n]',
    '[[package]]\nname = "sdk"\nversion = "0.0.0"\ndependencies = [\n "abi",\n "serde_json 1.0.0",\n]',
    `[[package]]\nname = "serde_json"\nversion = "1.0.0"\n${registry}\nchecksum = "aa"`,
    `[[package]]\nname = "unrelated"\nversion = "2.0.0"\n${registry}\nchecksum = "${unrelatedChecksum}"`,
    "",
  ].join("\n\n");
}

function write(relative: string, content: string): void {
  const abs = path.join(root, relative);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const moduleOf = (name: string) =>
  ({
    key: `modules/${name}`,
    dir: path.join(root, "modules", name),
    manifestPath: path.join(root, "modules", name, "telo.yaml"),
  }) as DiscoveredModule;

async function pinAll(): Promise<DiscoveredModule[]> {
  const modules = ["alpha", "beta", "gamma"].map(moduleOf);
  for (const module of modules) {
    const result = await stageModule(module, { pin: true, archives: createArchiveReader() });
    expect(result.failures).toEqual([]);
  }
  return modules;
}

describe("crate build inputs", () => {
  it("are recorded by stage --pin beside the crate, and a following check accepts them", async () => {
    const modules = await pinAll();
    expect(fs.readFileSync(modules[0]!.manifestPath, "utf8")).toMatch(
      /\n {4}build:\n {6}cargo: \.\/rust\n {6}inputs: sha256-[A-Za-z0-9_-]{43}\n {4}entries: \{\}\n/,
    );
    expect(await checkCrateInputs(modules)).toEqual([]);
  });

  it("move for a [patch] path crate the crate reaches, and for a cargo config above it", async () => {
    write("patched/Cargo.toml", '[package]\nname = "serde_json"\nversion = "1.0.0"\n');
    write("patched/src/lib.rs", "// patched\n");
    write(
      "Cargo.toml",
      fs.readFileSync(path.join(root, "Cargo.toml"), "utf8") +
        '\n[patch.crates-io]\nserde_json = { path = "patched" }\n',
    );
    write(
      "Cargo.lock",
      lockfile("bb").replace(
        `[[package]]\nname = "serde_json"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "aa"`,
        '[[package]]\nname = "serde_json"\nversion = "1.0.0"',
      ),
    );
    commitAll();
    const modules = await pinAll();

    write("patched/src/lib.rs", "// patched again\n");
    expect((await checkCrateInputs(modules)).map((f) => f.module)).toEqual([
      "modules/alpha",
      "modules/beta",
      "modules/gamma",
    ]);
    write("patched/src/lib.rs", "// patched\n");
    write(".cargo/config.toml", "[build]\nrustflags = []\n");
    commitAll();
    expect((await checkCrateInputs(modules)).map((f) => f.module)).toEqual([
      "modules/alpha",
      "modules/beta",
      "modules/gamma",
    ]);
  });

  it("refuses a crate git does not track, and reports a manifest that does not parse", async () => {
    write("modules/delta/rust/Cargo.toml", '[package]\nname = "delta"\nversion = "0.1.0"\n');
    write(
      "modules/delta/telo.yaml",
      fs.readFileSync(path.join(root, "modules/gamma/telo.yaml"), "utf8").replace("Gamma", "Delta"),
    );
    const delta = moduleOf("delta");
    const result = await stageModule(delta, { pin: true, archives: createArchiveReader() });
    expect(result.failures.map((f) => f.message).join("\n")).toContain("is not tracked by git");

    write("modules/delta/telo.yaml", "kind: Telo.Library\nmetadata: [\n");
    expect((await checkCrateInputs([delta])).map((f) => f.message).join("\n")).toContain("does not parse");
  });

  it("fail check for every source whose crate reaches a changed path dependency, naming each", async () => {
    const modules = await pinAll();
    write("sdk/abi/src/lib.rs", "pub const ABI: u32 = 3;\n");

    const failures = await checkCrateInputs(modules);
    expect(failures.map((f) => [f.module, f.source])).toEqual([
      ["modules/alpha", "prebuilt"],
      ["modules/beta", "prebuilt"],
    ]);
    expect(failures[0]!.message).toContain("the build inputs of crate 'rust' moved");
  });

  it("do not move for a change outside the crate, its path dependencies and the lock packages they reach", async () => {
    const modules = await pinAll();
    write("Cargo.lock", lockfile("cc"));
    write(
      "Cargo.toml",
      fs.readFileSync(path.join(root, "Cargo.toml"), "utf8").replace('"modules/*/rust"', '"modules/*/rust", "tools/x"') +
        'unrelated = "2"\n',
    );
    write("README.md", "edited\n");
    write("modules/alpha/rust/target/release/libalpha.so", "build output");
    write("modules/alpha/rust/scratch.rs", "// never added\n");
    write("modules/alpha/telo.yaml", fs.readFileSync(modules[0]!.manifestPath, "utf8") + "# edited\n");

    expect(await checkCrateInputs(modules)).toEqual([]);
  });
  // Every test spawns git a dozen or more times, and a Windows runner takes over
  // 100ms a spawn.
}, { timeout: 30_000 });
