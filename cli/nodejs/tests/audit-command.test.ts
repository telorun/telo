import { serializeModuleRecord, sha256Base64Url, type ComponentReport } from "@telorun/analyzer";
import { OciTransport, type PayloadLayer } from "@telorun/kernel";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { injectLayerIndex } from "../../../kernel/nodejs/src/bundle/files-integrity.js";
import { mockRegistry } from "../../../kernel/nodejs/tests/mock-oci-registry.js";
import { ModulePayloadBuilder } from "../src/bundle/module-payload.js";
import { CommitHistoryReader } from "../src/commit-reachability/commit-history.js";
import { audit, type AuditDeps } from "../src/commands/audit.js";
import { Output, installOutput } from "../src/output.js";
import { FakeGitHost, fakeHistory } from "./__fixtures__/commit-history/fake-git-host.js";

const HOST = "reg.test";
const noWait: AuditDeps["lookup"] = { sleep: async () => {} };

let workdir: string;
let reg: ReturnType<typeof mockRegistry>;
const realFetch = globalThis.fetch;
const registryRequests: string[] = [];
const standIns: string[] = [];

beforeAll(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "telo-audit-command-"));
  process.env.DOCKER_CONFIG = "/nonexistent/telo-oci-test";
  process.env.TELO_HUB_URL = "http://hub.invalid";
  process.env.TELO_CACHE_DIR = path.join(workdir, ".cache");
  reg = mockRegistry();
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (standIns.some((base) => url.startsWith(base))) return realFetch(input, init);
    registryRequests.push(url);
    return reg.impl(input, init);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
  delete process.env.DOCKER_CONFIG;
  delete process.env.TELO_HUB_URL;
  delete process.env.TELO_CACHE_DIR;
  fs.rmSync(workdir, { recursive: true, force: true });
});

afterEach(() => {
  process.exitCode = undefined;
});

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const pinOf = async (text: string) => `sha256-${await sha256Base64Url(new TextEncoder().encode(text))}`;

async function capture(work: () => Promise<void>, format: "text" | "json" = "text") {
  const stdout = { text: "", write: (chunk: string) => (stdout.text += chunk) };
  const stderr = { text: "", write: (chunk: string) => (stderr.text += chunk) };
  const restore = installOutput(new Output({ format, stdout, stderr, env: {} }));
  try {
    await work();
  } finally {
    restore();
  }
  const exit = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { stdout: stdout.text, stderr: stderr.text, exit };
}

function write(rel: string, content: string): string {
  const file = path.join(workdir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function recordLayer(name: string, components: ComponentReport[]): PayloadLayer {
  const text = serializeModuleRecord({ subject: { type: "library", name, version: "1.0.0" }, components, contains: [], incomplete: [] });
  return { role: "sbom", files: [{ name: "sbom.cdx.json", content: Buffer.from(text) }] };
}

async function publish(
  repo: string,
  name: string,
  version: string,
  layers: PayloadLayer[] | undefined,
  imports: Record<string, string> = {},
  extra: string[] = [],
): Promise<{ ref: string; pinned: string }> {
  const transport = new OciTransport();
  const lines = [`kind: Telo.Library`, `metadata:`, `  name: ${name}`, `  version: ${version}`, ...extra];
  if (Object.keys(imports).length > 0) {
    lines.push("imports:", ...Object.entries(imports).map(([alias, source]) => `  ${alias}: ${source}`));
  }
  const manifest = `${lines.join("\n")}\n`;
  const text = layers ? injectLayerIndex(manifest, await transport.layerIndex(layers)) : manifest;
  await transport.publish(`oci://${HOST}/${repo}`, { manifest: text, layers: layers ?? [] });
  const ref = `oci://${HOST}/${repo}@${version}`;
  return { ref, pinned: `${ref}#${await pinOf(text)}` };
}

function app(dir: string, imports: Record<string, string>): string {
  return write(
    `${dir}/telo.yaml`,
    ["kind: Telo.Application", "metadata:", "  name: Brochure", "  version: 1.0.0", "imports:",
      ...Object.entries(imports).map(([alias, source]) => `  ${alias}: ${source}`), ""].join("\n"),
  );
}

const STATIC = "pkg:npm/%40fastify/static";
const GHSA = "GHSA-83w8-p2f5-377r";
const CVSS = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N";
const component = (purl: string, version: string, occurrence = "role=library;format=js"): ComponentReport => ({ purl, version, occurrence });

interface Osv {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

/** A stand-in OSV: `advisories` maps `purl@version` to advisory records,
 *  `commits` a commit id to advisory records, and `repositories` lists the
 *  repositories it names in a record. */
async function startOsv(options: {
  advisories: Record<string, Record<string, unknown>[]>;
  commits?: Record<string, Record<string, unknown>[]>;
  repositories?: string[];
  pageSize?: number;
  failFrom?: number;
  refuse?: boolean;
}): Promise<Osv> {
  const requests: string[] = [];
  const records = new Map<string, Record<string, unknown>>();
  let batches = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (options.refuse) return reply(503, {});
      if (req.method === "POST" && req.url === "/v1/querybatch") {
        batches++;
        if (options.failFrom !== undefined && batches >= options.failFrom) return reply(503, {});
        const queries = (JSON.parse(body) as {
          queries: { package?: { purl?: string; ecosystem?: string; name?: string }; commit?: string; page_token?: string }[];
        }).queries;
        return reply(200, {
          results: queries.map((query) => {
            if (query.package?.ecosystem === "GIT") {
              return options.repositories?.includes(query.package.name!) ? { vulns: [{ id: "OSV-RECORDED" }] } : {};
            }
            const all = (query.commit ? options.commits?.[query.commit] : options.advisories[query.package!.purl!]) ?? [];
            for (const record of all) records.set(record.id as string, record);
            const size = options.pageSize ?? all.length;
            const from = query.page_token ? Number(query.page_token) : 0;
            const page = all.slice(from, from + size);
            const next = from + size < all.length ? { next_page_token: String(from + size) } : {};
            return { vulns: page.map((record) => ({ id: record.id })), ...next };
          }),
        });
      }
      const match = req.url?.match(/^\/v1\/vulns\/(.+)$/);
      const record = match ? records.get(decodeURIComponent(match[1]!)) : undefined;
      return record ? reply(200, record) : reply(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  standIns.push(url);
  return { url, requests, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

const staticAdvisory = (overrides: Record<string, unknown> = {}) => ({
  id: GHSA,
  aliases: ["CVE-2026-15074"],
  summary: "@fastify/static fails to reject dot-dot path segments, bypassing route guards",
  severity: [{ type: "CVSS_V3", score: CVSS }],
  affected: [{ package: { purl: "pkg:npm/@fastify/static" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "10.1.1" }] }] }],
  ...overrides,
});

const run = (manifest: string, osv: Osv | undefined, flags: { platform?: string; allowIncomplete?: boolean; osvUrl?: string } = {}, deps: AuditDeps = {}, format: "text" | "json" = "text") =>
  capture(
    () => audit({ manifest, ...flags }, { lookup: noWait, today: "2026-11-20", env: osv ? { TELO_OSV_URL: osv.url } : {}, ...deps }),
    format,
  );

const hubRequests = () => registryRequests.filter((url) => url.includes("hub.invalid"));

describe("telo audit over imported modules", () => {
  const osvs: Osv[] = [];
  afterAll(() => Promise.all(osvs.map((osv) => osv.close())));
  const start = async (options: Parameters<typeof startOsv>[0]) => {
    const osv = await startOsv(options);
    osvs.push(osv);
    return osv;
  };

  it("reports an advisory at the import carrying it, with the upgrade that removes it", async () => {
    const old = await publish("acme/http-server", "HttpServer", "0.45.0", [recordLayer("HttpServer", [component(STATIC, "10.1.0")])]);
    await publish("acme/http-server", "HttpServer", "0.46.0", [recordLayer("HttpServer", [component(STATIC, "10.1.1")])]);
    const entry = app("vulnerable", { Http: old.pinned });
    const osv = await start({ advisories: { [`${STATIC}@10.1.0`]: [staticAdvisory()] } });

    const text = await run(entry, osv);
    expect(text.exit).toBe(1);
    expect(text.stderr).toContain(
      `${path.join("vulnerable", "telo.yaml")}:6:9  error  Http (${old.ref}) ships @fastify/static 10.1.0, which has ${GHSA} (CVE-2026-15074, ${CVSS}): ` +
        "@fastify/static fails to reject dot-dot path segments, bypassing route guards. Fixed in @fastify/static 10.1.1. " +
        "`telo upgrade` moves Http to 0.46.0, which no longer carries it.  COMPONENT_VULNERABLE",
    );
    expect(text.stderr).toContain(`Brochure: 2 modules, 1 component checked, every selector, OSV ${osv.url}\n1 error\n`);
    // the main lookup and the hint's both went to the stand-in, and nothing asked the hub
    expect(osv.requests.filter((r) => r === "POST /v1/querybatch")).toHaveLength(2);
    expect(hubRequests()).toEqual([]);

    const json = JSON.parse((await run(entry, osv, {}, {}, "json")).stdout);
    expect(json).toMatchObject({ ok: false, errorCount: 1, warnCount: 0, ignored: [] });
    expect(json.diagnostics).toHaveLength(1);
    expect(json.diagnostics[0]).toMatchObject({
      line: 6,
      column: 9,
      severity: "error",
      code: "COMPONENT_VULNERABLE",
      advisory: {
        id: GHSA,
        aliases: ["CVE-2026-15074"],
        summary: "@fastify/static fails to reject dot-dot path segments, bypassing route guards",
        severity: [{ type: "CVSS_V3", score: CVSS }],
        component: `${STATIC}@10.1.0`,
        fixed: ["10.1.1"],
      },
      chain: [{ alias: "Http", source: old.ref }],
      upgrade: { alias: "Http", version: "0.46.0", resolves: true },
    });
  }, 60_000);

  it("says the upgrade does not remove it when the newest version still pins the carrying module", async () => {
    const httpOld = await publish("acme/http-server-pinned", "HttpServer", "0.45.0", [recordLayer("HttpServer", [component(STATIC, "10.1.0")])]);
    const first = await publish("acme/billing", "Billing", "1.2.0", [recordLayer("Billing", [])], { HttpServer: httpOld.pinned });
    await publish("acme/billing", "Billing", "1.3.0", [recordLayer("Billing", [])], { HttpServer: httpOld.pinned });
    const entry = app("pinning", { Billing: first.pinned });
    const osv = await start({ advisories: { [`${STATIC}@10.1.0`]: [staticAdvisory()] } });

    const text = await run(entry, osv);
    expect(text.exit).toBe(1);
    expect(text.stderr).toContain(
      `error  Billing (${first.ref}) imports HttpServer (${httpOld.ref}), which ships @fastify/static 10.1.0, which has ${GHSA}`,
    );
    expect(text.stderr).toContain(
      "`telo upgrade` moves Billing to 1.3.0, which still pins HttpServer 0.45.0: ask Billing's publisher for a version over a fixed HttpServer, or accept the advisory in telo-workspace.yaml.",
    );
    const json = JSON.parse((await run(entry, osv, {}, {}, "json")).stdout);
    expect(json.diagnostics[0].upgrade).toEqual({ alias: "Billing", version: "1.3.0", resolves: false });
    expect(json.diagnostics[0].chain.map((link: { alias: string }) => link.alias)).toEqual(["Billing", "HttpServer"]);
    expect(hubRequests()).toEqual([]);
  }, 60_000);

  it("resolves the upgrade hint for a library that requires variables its importer supplies", async () => {
    const needs = ["variables:", "  token:", "    type: string"];
    const old = await publish("acme/needy", "Needy", "1.0.0", [recordLayer("Needy", [component(STATIC, "10.1.0")])], {}, needs);
    await publish("acme/needy", "Needy", "1.1.0", [recordLayer("Needy", [component(STATIC, "10.1.1")])], {}, needs);
    const entry = write(
      "needy-app/telo.yaml",
      ["kind: Telo.Application", "metadata:", "  name: Brochure", "  version: 1.0.0", "imports:", "  Needy:", `    source: ${old.pinned}`, "    variables:", "      token: abc", ""].join("\n"),
    );
    const osv = await start({ advisories: { [`${STATIC}@10.1.0`]: [staticAdvisory()] } });
    const json = JSON.parse((await run(entry, osv, {}, {}, "json")).stdout);
    expect(json.diagnostics[0].upgrade).toEqual({ alias: "Needy", version: "1.1.0", resolves: true });
  }, 60_000);

  it("lists a component no database matches by version as a warning with its CPE, and exits 0", async () => {
    const cpe = "cpe:2.3:a:sqlite:sqlite:3.51.3:*:*:*:*:*:*:*";
    const sqlite = await publish("acme/vault", "Vault", "0.3.0", [recordLayer("Vault", [{ ...component("pkg:generic/sqlite", "3.51.3", "role=native;abi=node-141;arch=amd64;format=node;libc=gnu;os=linux"), cpe }])]);
    const entry = app("unchecked", { Vault: sqlite.pinned });
    const osv = await start({ advisories: {} });

    const text = await run(entry, osv);
    expect(text.exit).toBe(0);
    expect(text.stderr).toContain(`warning  Vault (${sqlite.ref}) ships sqlite 3.51.3 (pkg:generic/sqlite@3.51.3, ${cpe}), which no advisory database matches by version.`);
    expect(text.stderr).toContain("telo sbom ");
    expect(text.stderr).toContain("0 of 1 component checked");
    expect(osv.requests).toEqual([]);
    const json = JSON.parse((await run(entry, osv, {}, {}, "json")).stdout);
    expect(json).toMatchObject({ ok: true, errorCount: 0, warnCount: 1 });
    expect(json.diagnostics[0].code).toBe("COMPONENT_UNCHECKED");
  });

  it("sends no request past an unrecorded module, and goes on past it when asked", async () => {
    const bare = await publish("acme/bare", "Bare", "0.44.2", undefined);
    const entry = app("unrecorded", { Bare: bare.pinned });
    const osv = await start({ advisories: {} });

    const refused = await run(entry, osv);
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toContain("SBOM_INCOMPLETE");
    expect(osv.requests).toEqual([]);

    const allowed = await run(entry, osv, { allowIncomplete: true });
    expect(allowed.exit).toBe(0);
    expect(allowed.stderr.match(/ warning /g)).toHaveLength(1);
    expect(allowed.stderr).toContain("1 incomplete");
  });

  it("fails on a darwin-only occurrence until the platform flag leaves it out", async () => {
    const mac = await publish("acme/mac", "Mac", "1.0.0", [
      recordLayer("Mac", [component(STATIC, "10.1.0", "role=native;abi=node-141;arch=arm64;format=node;os=darwin")]),
    ]);
    const entry = app("darwin", { Mac: mac.pinned });
    const osv = await start({ advisories: { [`${STATIC}@10.1.0`]: [staticAdvisory()] } });
    expect((await run(entry, osv)).exit).toBe(1);
    expect((await run(entry, osv, { platform: "linux/amd64/gnu" })).exit).toBe(0);
  });

  it("fails on an advisory that records no severity", async () => {
    const mod = await publish("acme/noseverity", "NoSeverity", "1.0.0", [recordLayer("NoSeverity", [component(STATIC, "10.1.0")])]);
    const osv = await start({ advisories: { [`${STATIC}@10.1.0`]: [staticAdvisory({ severity: undefined, aliases: undefined })] } });
    const text = await run(app("noseverity", { Mod: mod.pinned }), osv);
    expect(text.exit).toBe(1);
    expect(text.stderr).toContain(`which has ${GHSA}: @fastify/static fails`);
  });

  it("answers a component set larger than one batch, served with page tokens", async () => {
    const many = Array.from({ length: 1002 }, (_, i) => component(`pkg:npm/p${i}`, "1.0.0"));
    const mod = await publish("acme/many", "Many", "1.0.0", [recordLayer("Many", many)]);
    const advisory = (id: string) => ({ id, summary: id, affected: [] });
    const osv = await start({
      pageSize: 1,
      advisories: {
        "pkg:npm/p5@1.0.0": [advisory("A-1")],
        "pkg:npm/p7@1.0.0": [advisory("A-2"), advisory("A-3")],
        "pkg:npm/p1001@1.0.0": [advisory("A-4")],
      },
    });
    const text = await run(app("many", { Many: mod.pinned }), osv);
    expect(text.exit).toBe(1);
    expect(text.stderr.match(/COMPONENT_VULNERABLE/g)).toHaveLength(4);
    expect(text.stderr).toContain("1002 components checked");
  }, 60_000);
});

describe("telo audit over components built from a repository", () => {
  const SQLITE = { url: "git+https://github.com/sqlite/sqlite", revision: "a5333afb9ad1aa473f8963b92caeaa955f47dc74" };
  const FORK = { url: "git+https://github.com/Balearica/tesseract", revision: "2a9c1c49c360462733c386d2a44fcd22c4e21411" };
  const occurrence = "role=assets";

  it("answers every component of a repository OSV names in no record unchecked, naming the repository", async () => {
    const mod = await publish("acme/ocr", "Ocr", "1.0.0", [
      recordLayer("Ocr", [
        { ...component("pkg:generic/tesseract", "5.3.0", occurrence), vcs: FORK, cpe: "cpe:2.3:a:tesseract-ocr:tesseract_ocr:5.3.0:*:*:*:*:*:*:*" },
        { ...component("pkg:generic/zlib", "1.2.12", occurrence), vcs: { url: "git+https://github.com/madler/zlib", revision: "21767c654d31d2dccdde4330529775c6c5fd5389" } },
      ]),
    ]);
    const osv = await startOsv({ advisories: {}, repositories: [] });
    try {
      const text = await run(app("by-revision-unknown", { Ocr: mod.pinned }), osv);
      expect(text.exit).toBe(0);
      expect(text.stderr).toContain(
        `warning  Ocr (${mod.ref}) ships tesseract 5.3.0 (pkg:generic/tesseract@5.3.0, cpe:2.3:a:tesseract-ocr:tesseract_ocr:5.3.0:*:*:*:*:*:*:*), ` +
          "built from git+https://github.com/Balearica/tesseract at 2a9c1c49c360; OSV records no advisory against that repository, " +
          "so an empty answer for this revision is no verdict. Check it with a scanner that matches by CPE: telo sbom ",
      );
      expect(text.stderr).toContain("0 of 2 components checked");
      expect(osv.requests).toEqual(["POST /v1/querybatch"]);
      const json = JSON.parse((await run(app("by-revision-unknown", { Ocr: mod.pinned }), osv, {}, {}, "json")).stdout);
      expect(json.diagnostics.map((d: { code: string; message: string }) => [d.code, d.message.includes("github.com/madler/zlib")])).toEqual([
        ["COMPONENT_UNCHECKED", false],
        ["COMPONENT_UNCHECKED", true],
      ]);
    } finally {
      await osv.close();
    }
  });

  it("reports an advisory its revision matches, with the commit that fixes it", async () => {
    const mod = await publish("acme/vault-rev", "Vault", "1.0.0", [
      recordLayer("Vault", [{ ...component("pkg:generic/sqlite", "3.51.3", occurrence), vcs: SQLITE }]),
    ]);
    const fixed = "3cd92ce875fd4e5601e535c35fef33494a6684e3";
    const osv = await startOsv({
      advisories: {},
      repositories: ["https://github.com/sqlite/sqlite"],
      commits: {
        [SQLITE.revision]: [
          {
            id: "CVE-2025-29087",
            summary: "concat_ws() overflows",
            affected: [{ ranges: [{ type: "GIT", repo: "https://github.com/sqlite/sqlite", events: [{ introduced: "0" }, { fixed }] }] }],
          },
        ],
      },
    });
    try {
      const text = await run(app("by-revision", { Vault: mod.pinned }), osv);
      expect(text.exit).toBe(1);
      expect(text.stderr).toContain(
        `Vault (${mod.ref}) ships sqlite 3.51.3, which has CVE-2025-29087: concat_ws() overflows. ` +
          `Fixed by commit ${fixed} of https://github.com/sqlite/sqlite.`,
      );
      expect(text.stderr).toContain("1 component checked");
    } finally {
      await osv.close();
    }
  });

  it("words the fix as a commit for an advisory only the commit matched, whatever the package type", async () => {
    const mod = await publish("acme/vault-npm-rev", "Vault", "1.0.0", [
      recordLayer("Vault", [{ ...component("pkg:npm/engine-core", "7.0.0", occurrence), vcs: SQLITE }]),
    ]);
    const fixed = "3cd92ce875fd4e5601e535c35fef33494a6684e3";
    const osv = await startOsv({
      advisories: {},
      repositories: ["https://github.com/sqlite/sqlite"],
      commits: {
        [SQLITE.revision]: [
          {
            id: "CVE-2025-29087",
            summary: "concat_ws() overflows",
            affected: [{ ranges: [{ type: "GIT", repo: "https://github.com/sqlite/sqlite", events: [{ introduced: "0" }, { fixed }] }] }],
          },
        ],
      },
    });
    try {
      const text = await run(app("by-revision-npm", { Vault: mod.pinned }), osv);
      expect(text.exit).toBe(1);
      expect(text.stderr).toContain(`which has CVE-2025-29087: concat_ws() overflows. Fixed by commit ${fixed} of https://github.com/sqlite/sqlite.`);
    } finally {
      await osv.close();
    }
  });

  it("checks a local module's revisions itself, and names where to declare one it lacks", async () => {
    const history = fakeHistory();
    const host = new FakeGitHost(history.all, { "refs/heads/main": { id: history.head.id } });
    await host.start();
    const sha = "a".repeat(64);
    write("local-vcs/modules/engine/NOTICE", "notice\n");
    write("local-vcs/modules/engine/telo.yaml", [
      "kind: Telo.Library",
      "metadata: { name: Engine, version: 0.1.0 }",
      "assets: [./engine.wasm]",
      "sources:",
      "  core:",
      "    version: 7.0.0",
      "    purl: pkg:npm/engine-core",
      "    contains:",
      "      - { purl: pkg:generic/engine, version: 5.3.0, vcs: { url: git+https://git.test/acme/engine, revision: " + history.fork.id + " } }",
      "      - { purl: pkg:generic/zlib, version: 1.2.12 }",
      "    url: https://example.test/{upstream}.tar.gz",
      "    archive: tar.gz",
      "    notices: [./NOTICE]",
      "    entries:",
      `      ./engine.wasm: { upstream: core, member: engine.wasm, sha256: ${sha}, executable: false }`,
      "",
    ].join("\n"));
    const entry = app("local-vcs", { Engine: "./modules/engine" });
    const osv = await startOsv({ advisories: {} });
    try {
      const text = await run(entry, osv, {}, { revisions: new CommitHistoryReader({ fetch: host.fetch, sleep: async () => {} }) });
      expect(text.exit).toBe(1);
      expect(text.stderr).toMatch(
        new RegExp(
          `${escapeRegExp(path.join("local-vcs", "modules", "engine", "telo.yaml"))}:9:\\d+  error  sources\\.core\\.contains\\[0\\]\\.vcs\\.revision ${history.fork.id} ` +
            "is not reachable from any branch or tag of https://git\\.test/acme/engine\\.",
        ),
      );
      expect(text.stderr).toContain("SOURCE_REVISION_UNREACHABLE");
      expect(text.stderr).toContain(
        `ships engine 5.3.0 (pkg:generic/engine@5.3.0), built from git+https://git.test/acme/engine at ${history.fork.id.slice(0, 12)}; ` +
          "its revision is not proven in that repository's history, so it was looked up by its package URL alone",
      );
      expect(text.stderr).toContain(
        "ships zlib 1.2.12 (pkg:generic/zlib@1.2.12), which no advisory database matches by version. " +
          "Declare `vcs:` on sources.core.contains[1] — the repository and commit it is built from — so it can be checked by revision.",
      );
    } finally {
      await osv.close();
      await host.stop();
    }
  }, 60_000);
});

describe("telo audit endpoint and failures", () => {
  it("lets --osv-url beat TELO_OSV_URL, and refuses an address that is not http or https", async () => {
    const mod = await publish("acme/clean", "Clean", "1.0.0", [recordLayer("Clean", [component("pkg:npm/clean", "1.0.0")])]);
    const entry = app("endpoint", { Clean: mod.pinned });
    const osv = await startOsv({ advisories: {} });
    try {
      const flagged = await capture(() =>
        audit({ manifest: entry, osvUrl: osv.url }, { lookup: noWait, env: { TELO_OSV_URL: "http://127.0.0.1:9" } }),
      );
      expect(flagged.exit).toBe(0);
      expect(osv.requests).toEqual(["POST /v1/querybatch"]);
      expect(flagged.stderr).toContain(`OSV ${osv.url}`);

      const bad = await capture(() => audit({ manifest: entry, osvUrl: "ftp://osv.internal.acme.dev" }, { env: {} }));
      expect(bad.exit).toBe(2);
      expect(bad.stderr).toBe('Invalid value for --osv-url: "ftp://osv.internal.acme.dev" is not an http or https URL.\n');
      const badEnv = await capture(() => audit({ manifest: entry }, { env: { TELO_OSV_URL: "ftp://x" } }));
      expect(badEnv.exit).toBe(2);
      expect(badEnv.stderr).toContain("Invalid value for TELO_OSV_URL");
    } finally {
      await osv.close();
    }
  });

  it("fails the run, judging nothing, when the endpoint refuses or one page of several fails", async () => {
    const mod = await publish("acme/paged", "Paged", "1.0.0", [recordLayer("Paged", [component("pkg:npm/p", "1.0.0")])]);
    const entry = app("lookup-fails", { Paged: mod.pinned });
    const advisories = { "pkg:npm/p@1.0.0": [{ id: "A-1", summary: "s" }, { id: "A-2", summary: "s" }] };
    for (const options of [{ refuse: true }, { pageSize: 1, failFrom: 2 }]) {
      const osv = await startOsv({ advisories, ...options });
      try {
        const result = await run(entry, osv);
        expect(result.exit).toBe(1);
        expect(result.stderr).toContain(`${osv.url}/v1/querybatch gave no answer after`);
        expect(result.stderr).toContain("No component was judged. Check the address (--osv-url, TELO_OSV_URL) or the network, and run again.");
        expect(result.stderr).toContain("ADVISORY_LOOKUP_FAILED");
        expect(result.stderr).not.toContain("COMPONENT_VULNERABLE");
      } finally {
        await osv.close();
      }
    }
  });
});

describe("telo audit over a local module", () => {
  it("names the dependency to raise, with no upgrade", async () => {
    write("local/modules/lib/telo.yaml", [
      "kind: Telo.Library",
      "metadata: { name: Lib, version: 0.1.0 }",
      "exports: { kinds: [Render] }",
      "---",
      "kind: Telo.Definition",
      "metadata: { name: Render }",
      "capability: Telo.Invocable",
      "controllers:",
      "  - pkg:telo/local/js?path=./nodejs/lib.mjs&local_path=./nodejs/src/index.ts#Render",
      "schema: { type: object }",
      "",
    ].join("\n"));
    write("local/modules/lib/nodejs/src/index.ts", 'import { leftish } from "leftish";\nexport const Render = { leftish };\n');
    write("local/modules/lib/nodejs/node_modules/leftish/package.json", '{ "name": "leftish", "version": "1.0.0", "main": "index.js" }');
    write("local/modules/lib/nodejs/node_modules/leftish/index.js", "exports.leftish = 1;\n");
    const entry = app("local", { Lib: "./modules/lib" });
    const osv = await startOsv({ advisories: { "pkg:npm/leftish@1.0.0": [{ id: "A-9", summary: "left", affected: [] }] } });
    try {
      const text = await run(entry, osv);
      expect(text.exit).toBe(1);
      expect(text.stderr).toContain("Lib (./modules/lib) ships leftish 1.0.0, which has A-9: left. No fixed version is known. Raise the dependency leftish in Lib's package.json to a fixed version.");
      const json = JSON.parse((await run(entry, osv, {}, {}, "json")).stdout);
      expect(json.diagnostics[0]).toMatchObject({ code: "COMPONENT_VULNERABLE", chain: [], upgrade: null });
    } finally {
      await osv.close();
    }
  }, 60_000);
});

describe("telo audit and the workspace marker's audit block", () => {
  async function accepted(dir: string, marker: string) {
    const mod = await publish(`acme/${dir}`, "Carrier", "1.0.0", [recordLayer("Carrier", [component(STATIC, "10.1.0")])]);
    const entry = app(dir, { Http: mod.pinned });
    write(`${dir}/telo-workspace.yaml`, marker);
    const osv = await startOsv({ advisories: { [`${STATIC}@10.1.0`]: [staticAdvisory()] } });
    return { entry, osv };
  }
  const ignoring = "audit:\n  ignore:\n    - id: CVE-2026-15074\n      reason: Serves its own static site.\n      expires: 2026-12-31\n";

  it("accepts an advisory by an alias until its date, then fails naming the entry", async () => {
    const { entry, osv } = await accepted("accepting", ignoring);
    try {
      const before = await run(entry, osv, {}, { today: "2026-12-31" });
      expect(before.exit).toBe(0);
      expect(before.stderr).toContain(`ignored ${GHSA} (CVE-2026-15074) in Http, @fastify/static 10.1.0, until 2026-12-31: Serves its own static site.`);
      const json = JSON.parse((await run(entry, osv, {}, { today: "2026-12-31" }, "json")).stdout);
      expect(json.ignored).toEqual([
        { id: GHSA, reason: "Serves its own static site.", expires: "2026-12-31", component: `${STATIC}@10.1.0`, chain: [{ alias: "Http", source: expect.stringContaining("acme/accepting@1.0.0") }] },
      ]);

      const after = await run(entry, osv, {}, { today: "2027-01-04" });
      expect(after.exit).toBe(1);
      expect(after.stderr).toMatch(/The audit\.ignore entry accepting it \(\S*telo-workspace\.yaml:3:7\) expired on 2026-12-31\./);
    } finally {
      await osv.close();
    }
  });

  it("refuses the run on an entry with no reason, and on a block name mistyped", async () => {
    const noReason = await accepted("no-reason", "audit:\n  ignore:\n    - id: CVE-2026-15074\n      expires: 2026-12-31\n");
    const typo = await accepted("typo", "audti:\n  ignore: []\n");
    try {
      const refused = await run(noReason.entry, noReason.osv);
      expect(refused.exit).toBe(1);
      expect(refused.stderr).toMatch(/telo-workspace\.yaml:3:7  error  audit\.ignore\[0\] has no reason\. Every accepted advisory says why it is accepted, beside its id and expires\.  WORKSPACE_INVALID_VALUE/);
      const mistyped = await run(typo.entry, typo.osv);
      expect(mistyped.exit).toBe(1);
      expect(mistyped.stderr).toContain("Did you mean 'audit'?");
      expect([...noReason.osv.requests, ...typo.osv.requests]).toEqual([]);
    } finally {
      await noReason.osv.close();
      await typo.osv.close();
    }
  });
});
