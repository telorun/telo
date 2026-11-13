import * as fs from "node:fs";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { host, read, run, tempRepo } from "./fixture.js";

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
  vi.unstubAllGlobals();
});

const pkg = (name: string, version: string, extra: object = {}) => JSON.stringify({ name, version, ...extra }, null, 2) + "\n";

function changesetsRepo(config: object): string {
  const root = tempRepo({
    "package.json": pkg("root", "0.0.0", { private: true, workspaces: ["packages/*"], devDependencies: { "@changesets/cli": "^2.0.0" } }),
    "package-lock.json": "{}\n",
    "packages/a/package.json": pkg("@fx/a", "1.1.0-rc.2"),
    "packages/b/package.json": pkg("@fx/b", "1.1.0-rc.2"),
    "packages/c/package.json": pkg("@fx/c", "3.0.0"),
    "packages/d/package.json": pkg("@fx/d", "0.1.0", { private: true }),
    ".changeset/config.json": JSON.stringify(config),
    ".changeset/pre.json": JSON.stringify({ mode: "pre", tag: "rc", changesets: ["brave-lions"] }),
    ".changeset/README.md": "# Changesets\n",
    ".changeset/brave-lions.md": '---\n"@fx/a": minor\n"@fx/b": patch\n---\n\nA new export.\n',
    ".github/workflows/release.yml": "jobs:\n  r:\n    steps:\n      - uses: changesets/action@v1\n",
  });
  roots.push(root);
  return root;
}

function tarball(name: string, version: string): { bytes: Uint8Array; integrity: string } {
  const body = Buffer.from(pkg(name, version));
  const header = Buffer.alloc(512);
  header.write("package/package.json", 0);
  header.write("0000644\0", 100);
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("0", 156);
  const bytes = gzipSync(Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512), Buffer.alloc(1024)]));
  return { bytes, integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` };
}

/** A registry publishing @fx/a and @fx/b at 1.0.0 and 1.1.0-rc.2. */
function stubRegistry(): void {
  vi.stubGlobal("fetch", async (url: string) => {
    const match = /registry\.npmjs\.org\/(@fx%2f[ab])(?:\/(.+))?$/.exec(url);
    const tgz = /\/tarballs\/(.+)\/(.+)\.tgz$/.exec(url);
    if (tgz) return new Response(tarball(decodeURIComponent(tgz[1]!), tgz[2]!).bytes);
    if (!match) return new Response("", { status: 404 });
    const name = decodeURIComponent(match[1]!);
    if (!match[2]) return new Response(JSON.stringify({ versions: { "1.0.0": {}, "1.1.0-rc.2": {} } }));
    const version = decodeURIComponent(match[2]);
    if (version !== "1.0.0" && version !== "1.1.0-rc.2") return new Response("", { status: 404 });
    return new Response(
      JSON.stringify({ dist: { tarball: `https://files.example/tarballs/${encodeURIComponent(name)}/${version}.tgz`, integrity: tarball(name, version).integrity } }),
    );
  });
}

describe("adopt changesets", () => {
  it("writes the marker, the fragments and the npm ledger, and deletes .changeset/", async () => {
    const root = changesetsRepo({ fixed: [["@fx/a", "@fx/b"]], linked: [], ignore: ["@fx/c"] });
    stubRegistry();
    const { host: h, recorded } = host();
    const adopted = await run(h, recorded, root, ["adopt", "changesets"]);
    expect(adopted.exitCode).toBe(0);
    expect(read(root, "telo-workspace.yaml")).toBe(
      [
        "release:",
        "  units:",
        "    - { path: packages/a, ecosystem: npm }",
        "    - { path: packages/b, ecosystem: npm }",
        "    - { path: packages/c, ecosystem: npm }",
        "    - { path: packages/d, ecosystem: npm }",
        '    - "!packages/c"',
        '    - "!packages/d"',
        "  groups:",
        "    fixed-1: [packages/a, packages/b]",
        "",
      ].join("\n"),
    );
    expect(read(root, ".changes/pending/brave-lions.yaml")).toBe(
      "units:\n  packages/a: Added\n  packages/b: Fixed\nbody: A new export.\n",
    );
    const ledger = read(root, ".changes/ledger.yaml");
    expect(ledger).toMatch(/packages\/a:\n {4}version: 1\.0\.0\n {4}layers:\n {6}npm:\n {8}\.: sha256-/);
    expect(ledger).toMatch(/candidate:\n {6}version: 1\.1\.0-rc\.2/);
    expect(fs.existsSync(path.join(root, ".changeset"))).toBe(false);
    expect(adopted.payload.deleted).toEqual(expect.arrayContaining([".changeset/pre.json", ".changeset/config.json"]));
    expect(adopted.payload.leftBehind).toEqual(
      expect.arrayContaining([
        expect.stringContaining(".github/workflows/release.yml:4"),
        "package.json: devDependencies.@changesets/cli",
        expect.stringContaining("private package @fx/d"),
      ]),
    );
    // The adopted tree plans: the pending fragment raises the group to its final.
    const status = await run(h, recorded, root, ["status", "--base", "HEAD"]);
    expect((status.payload.units as { key: string; to: string }[]).map((u) => [u.key, u.to])).toEqual([
      ["packages/a", "1.1.0"],
      ["packages/b", "1.1.0"],
    ]);
  }, 60_000);

  it("refuses linked groups and changes nothing", async () => {
    const root = changesetsRepo({ fixed: [], linked: [["@fx/a", "@fx/b"]], ignore: [] });
    const { host: h, recorded } = host();
    expect((await run(h, recorded, root, ["adopt", "changesets"])).exitCode).toBe(1);
    expect(recorded.stderr.join("\n")).toContain("'linked' group");
    expect(fs.existsSync(path.join(root, ".changeset/config.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "telo-workspace.yaml"))).toBe(false);
  });
});
